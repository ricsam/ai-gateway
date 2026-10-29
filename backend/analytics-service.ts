import { sql, type SQL } from "drizzle-orm";
import db from "./db";
import { groupMembersTable, userTable } from "./schema";
import { eq, sum } from "drizzle-orm";
import { getTimeRangeBounds, type TimeRange } from "../shared/analytics-time-ranges";
import { wholeBucketStart, type AggregateTable } from "./analytics-window";

export { getTimeRangeBounds, type TimeRange } from "../shared/analytics-time-ranges";
export type BucketSize = "15s" | "1m" | "5m" | "30m" | "1h" | "1d" | "1w" | "1mo";
export type AnalyticsScope = { userId?: string; groupId?: string };
type SourceTable = "credit_events" | AggregateTable;

export const ALLOWED_BUCKETS: Record<TimeRange, { allowed: BucketSize[]; default: BucketSize }> = {
  hour: { allowed: ["15s", "1m", "5m"], default: "5m" },
  day: { allowed: ["5m", "30m", "1h"], default: "1h" },
  week: { allowed: ["1d"], default: "1d" },
  month: { allowed: ["1d", "1w"], default: "1d" },
  quarter: { allowed: ["1w"], default: "1w" },
  year: { allowed: ["1mo"], default: "1mo" },
};

export function validateTimeRange(value: string | null | undefined): TimeRange {
  if (value && value in ALLOWED_BUCKETS) return value as TimeRange;
  if (!value) return "month";
  throw new Error(`Invalid time range "${value}"`);
}

export function validateBucketSize(timeRange: TimeRange, bucketSize?: string | null): BucketSize {
  const config = ALLOWED_BUCKETS[timeRange];
  if (!bucketSize) return config.default;
  if (config.allowed.includes(bucketSize as BucketSize)) return bucketSize as BucketSize;
  throw new Error(`Invalid bucket size "${bucketSize}" for time range "${timeRange}". Allowed: ${config.allowed.join(", ")}`);
}

export function getBucketInterval(bucketSize: BucketSize): string {
  return ({ "15s": "15 seconds", "1m": "1 minute", "5m": "5 minutes", "30m": "30 minutes", "1h": "1 hour", "1d": "1 day", "1w": "1 week", "1mo": "1 month" } as const)[bucketSize];
}

export function getSourceTable(bucketSize: BucketSize): SourceTable {
  if (bucketSize === "15s" || bucketSize === "1m") return "credit_events";
  if (bucketSize === "5m" || bucketSize === "30m") return "credit_events_5m";
  if (bucketSize === "1h") return "credit_events_1h";
  return "credit_events_1d";
}

export function getTimeColumn(source: SourceTable): "time" | "bucket" {
  return source === "credit_events" ? "time" : "bucket";
}

function scopeSql(scope: AnalyticsScope | undefined): SQL {
  if (scope?.userId) return sql`AND user_id = ${scope.userId}`;
  if (scope?.groupId) return sql`AND user_id IN (SELECT user_id FROM group_members WHERE group_id = ${scope.groupId})`;
  return sql``;
}

function usageOnlySql(source: SourceTable): SQL {
  if (source === "credit_events") return sql`AND type IN ('usage', 'chat', 'api', 'embedding')`;
  return sql`AND model IS NOT NULL`;
}

function sourceParts(bucket: BucketSize) {
  const source = getSourceTable(bucket);
  return { source, timeColumn: getTimeColumn(source), interval: getBucketInterval(bucket) };
}

function iso(value: Date): string {
  // Dates are generated internally. Keep literal bounds because TimescaleDB's
  // gapfill planner does not reliably infer parameterized start/finish values.
  return value.toISOString().replace(/'/g, "''");
}

function gapfill(bucket: BucketSize, start: Date, end: Date): SQL {
  return sql.raw(`time_bucket_gapfill(INTERVAL '${getBucketInterval(bucket)}', "time", '${iso(start)}'::timestamptz, '${iso(end)}'::timestamptz)`);
}

// Columns that the queries below read; credit_events and its continuous aggregates share them.
const LEDGER_COLUMNS = sql.raw("user_id, model, credits_consumed, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens");

/**
 * The ledger in [start, end) as a FROM-clause subquery named "ledger" with a
 * "time" column. Aggregate-backed intervals read the window's partial first
 * aggregate bucket from credit_events, because that bucket also holds events
 * from before the window: filtering on its bucket start would drop its
 * in-window events, such as the first day of "Last 7 days". Whole buckets come
 * from the continuous aggregate, which answers buckets that its refresh policy
 * has not materialized yet in real time (drizzle/0006_realtime_credit_aggregates.sql).
 */
function ledgerRows(bucket: BucketSize, start: Date, end: Date, filter: { scope?: AnalyticsScope; usageOnly?: boolean } = {}): SQL {
  const source = getSourceTable(bucket);
  const where = (table: SourceTable, from: Date, to: Date) => {
    const column = sql.raw(`"${getTimeColumn(table)}"`);
    return sql`WHERE ${column} >= '${sql.raw(iso(from))}'::timestamptz AND ${column} < '${sql.raw(iso(to))}'::timestamptz
      ${scopeSql(filter.scope)} ${filter.usageOnly ? usageOnlySql(table) : sql``}`;
  };
  const raw = (from: Date, to: Date) => sql`SELECT "time", ${LEDGER_COLUMNS} FROM credit_events ${where("credit_events", from, to)}`;
  if (source === "credit_events") return sql`(${raw(start, end)}) AS ledger`;
  const aggregateStart = wholeBucketStart(source, start, end);
  return sql`(
    ${raw(start, aggregateStart)}
    UNION ALL
    SELECT bucket AS "time", ${LEDGER_COLUMNS} FROM ${sql.raw(source)} ${where(source, aggregateStart, end)}
  ) AS ledger`;
}

export async function getCreditsConsumed(timeRange: TimeRange, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const bucket = validateBucketSize(timeRange, bucketSize);
  const { start, end } = getTimeRangeBounds(timeRange);
  const result = await db.execute(sql`
    SELECT ${gapfill(bucket, start, end)} AS bucket, COALESCE(SUM(credits_consumed), 0) AS consumed
    FROM ${ledgerRows(bucket, start, end, { scope, usageOnly: true })}
    GROUP BY 1 ORDER BY 1
  `);
  return (result.rows as any[]).map((row) => ({ time: new Date(row.bucket).toISOString(), consumed: Number(row.consumed ?? 0) }));
}

async function currentBalance(scope?: AnalyticsScope): Promise<number> {
  if (scope?.userId) {
    const [user] = await db.select({ value: userTable.creditBalance }).from(userTable).where(eq(userTable.id, scope.userId)).limit(1);
    return user?.value ?? 0;
  }
  if (scope?.groupId) {
    const [result] = await db.select({ value: sum(userTable.creditBalance) }).from(groupMembersTable)
      .innerJoin(userTable, eq(groupMembersTable.userId, userTable.id)).where(eq(groupMembersTable.groupId, scope.groupId));
    return Number(result?.value ?? 0);
  }
  const [result] = await db.select({ value: sum(userTable.creditBalance) }).from(userTable);
  return Number(result?.value ?? 0);
}

// Burn-down points are balances at the end of each bucket, so whole aggregate
// buckets suffice here and in getGroupUserBurndowns: the window's partial first
// bucket is counted in the opening balance, which gives the same points.
export async function getBalanceBurndown(timeRange: TimeRange, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const bucket = validateBucketSize(timeRange, bucketSize);
  const { start, end } = getTimeRangeBounds(timeRange);
  const { source, timeColumn, interval } = sourceParts(bucket);
  const [balance, before, deltas] = await Promise.all([
    currentBalance(scope),
    db.execute(sql`SELECT COALESCE(SUM(credits_added - credits_consumed), 0) AS value FROM ${sql.raw(source)} WHERE "${sql.raw(timeColumn)}" < ${start.toISOString()}::timestamptz ${scopeSql(scope)}`),
    db.execute(sql`
      SELECT time_bucket_gapfill(
        INTERVAL '${sql.raw(interval)}', "${sql.raw(timeColumn)}",
        '${sql.raw(iso(start))}'::timestamptz, '${sql.raw(iso(end))}'::timestamptz
      ) AS bucket, COALESCE(SUM(credits_added - credits_consumed), 0) AS delta
      FROM ${sql.raw(source)}
      WHERE "${sql.raw(timeColumn)}" >= '${sql.raw(iso(start))}'::timestamptz
        AND "${sql.raw(timeColumn)}" < '${sql.raw(iso(end))}'::timestamptz ${scopeSql(scope)}
      GROUP BY 1 ORDER BY 1
    `),
  ]);
  let running = Number((before.rows[0] as any)?.value ?? 0);
  const data = (deltas.rows as any[]).map((row) => ({ time: new Date(row.bucket).toISOString(), balance: running += Number(row.delta ?? 0) }));
  return { data, currentBalance: balance };
}

export async function getUsageByModel(timeRange: TimeRange, bucketSize?: BucketSize, scope?: AnalyticsScope, topN = 5) {
  const bucket = validateBucketSize(timeRange, bucketSize);
  const { start, end } = getTimeRangeBounds(timeRange);
  const ledger = ledgerRows(bucket, start, end, { scope });
  const limit = Math.min(Math.max(topN, 1), 20);
  const top = await db.execute(sql`
    SELECT model, SUM(credits_consumed) AS total FROM ${ledger}
    WHERE model IS NOT NULL
    GROUP BY model ORDER BY total DESC LIMIT ${limit}
  `);
  const models = (top.rows as any[]).map((row) => String(row.model));
  if (!models.length) return { data: [] as { time: string; model: string; consumed: number }[], models };
  const inList = sql.join(models.map((model) => sql`${model}`), sql`, `);
  const selected = await db.execute(sql`
    SELECT ${gapfill(bucket, start, end)} AS bucket, model, COALESCE(SUM(credits_consumed), 0) AS consumed
    FROM ${ledger}
    WHERE model IN (${inList})
    GROUP BY 1, 2 ORDER BY 1, 2
  `);
  const data = (selected.rows as any[]).map((row) => ({ time: new Date(row.bucket).toISOString(), model: String(row.model), consumed: Number(row.consumed ?? 0) }));
  const other = await db.execute(sql`
    SELECT ${gapfill(bucket, start, end)} AS bucket, COALESCE(SUM(credits_consumed), 0) AS consumed
    FROM ${ledger}
    WHERE model IS NOT NULL AND model NOT IN (${inList})
    GROUP BY 1 ORDER BY 1
  `);
  if ((other.rows as any[]).some((row) => Number(row.consumed ?? 0) > 0)) {
    models.push("Other");
    data.push(...(other.rows as any[]).map((row) => ({ time: new Date(row.bucket).toISOString(), model: "Other", consumed: Number(row.consumed ?? 0) })));
  }
  return { data, models };
}

export interface TokensConsumedRow {
  time: string; inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWrite5mTokens: number; cacheWrite1hTokens: number; total: number;
}

export async function getTokensConsumed(timeRange: TimeRange, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const bucket = validateBucketSize(timeRange, bucketSize);
  const { start, end } = getTimeRangeBounds(timeRange);
  const result = await db.execute(sql`
    SELECT ${gapfill(bucket, start, end)} AS bucket,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
      COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens
    FROM ${ledgerRows(bucket, start, end, { scope, usageOnly: true })}
    GROUP BY 1 ORDER BY 1
  `);
  const summary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, total: 0 };
  const data: TokensConsumedRow[] = (result.rows as any[]).map((row) => {
    const entry = {
      time: new Date(row.bucket).toISOString(), inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0), cacheWrite5mTokens: Number(row.cache_write_5m_tokens ?? 0), cacheWrite1hTokens: Number(row.cache_write_1h_tokens ?? 0), total: 0,
    };
    entry.total = entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWrite5mTokens + entry.cacheWrite1hTokens;
    summary.inputTokens += entry.inputTokens; summary.outputTokens += entry.outputTokens; summary.cacheReadTokens += entry.cacheReadTokens;
    summary.cacheWrite5mTokens += entry.cacheWrite5mTokens; summary.cacheWrite1hTokens += entry.cacheWrite1hTokens; summary.total += entry.total;
    return entry;
  });
  return { data, summary };
}

export async function getModelSummary(timeRange: TimeRange, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const bucket = validateBucketSize(timeRange, bucketSize);
  const { start, end } = getTimeRangeBounds(timeRange);
  const result = await db.execute(sql`
    SELECT model, SUM(credits_consumed) AS total_credits, SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_5m_tokens) AS cache_write_5m_tokens, SUM(cache_write_1h_tokens) AS cache_write_1h_tokens
    FROM ${ledgerRows(bucket, start, end, { scope })}
    WHERE model IS NOT NULL
    GROUP BY model ORDER BY total_credits DESC
  `);
  const models = (result.rows as any[]).map((row) => ({
    model: String(row.model), totalCredits: Number(row.total_credits ?? 0), inputTokens: Number(row.input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0), cacheWrite5mTokens: Number(row.cache_write_5m_tokens ?? 0), cacheWrite1hTokens: Number(row.cache_write_1h_tokens ?? 0), percentOfTotal: 0,
  }));
  const total = models.reduce((value, model) => value + model.totalCredits, 0);
  for (const model of models) model.percentOfTotal = total ? model.totalCredits / total * 100 : 0;
  return { models };
}

export async function getUserSummary(timeRange: TimeRange, groupId?: string) {
  const bucket = ALLOWED_BUCKETS[timeRange].default;
  const { start, end } = getTimeRangeBounds(timeRange);
  const result = await db.execute(sql`
    SELECT ledger.user_id, u.username, SUM(ledger.credits_consumed) AS credits_used,
      COUNT(DISTINCT DATE(ledger."time")) AS active_days, MAX(ledger."time") AS last_activity
    FROM ${ledgerRows(bucket, start, end, { scope: groupId ? { groupId } : undefined, usageOnly: true })}
      JOIN "user" u ON u.id = ledger.user_id
    WHERE ledger.credits_consumed > 0
    GROUP BY ledger.user_id, u.username ORDER BY credits_used DESC
  `);
  const users = (result.rows as any[]).map((row) => {
    const creditsUsed = Number(row.credits_used ?? 0); const activeDays = Number(row.active_days ?? 0);
    return { userId: String(row.user_id), username: String(row.username), creditsUsed, activeDays, avgCreditsPerDay: activeDays ? creditsUsed / activeDays : 0, lastActivity: row.last_activity ? new Date(row.last_activity).toISOString() : null, percentOfTotal: 0 };
  });
  const total = users.reduce((value, user) => value + user.creditsUsed, 0);
  for (const user of users) user.percentOfTotal = total ? user.creditsUsed / total * 100 : 0;
  return { users };
}

export async function getGroupSummary(timeRange: TimeRange) {
  const bucket = ALLOWED_BUCKETS[timeRange].default;
  const { start, end } = getTimeRangeBounds(timeRange);
  const result = await db.execute(sql`
    SELECT gm.group_id, g.name AS group_name, SUM(ledger.credits_consumed) AS credits_used,
      COUNT(DISTINCT ledger.user_id) AS active_users
    FROM group_members gm JOIN groups g ON g.id = gm.group_id
      JOIN ${ledgerRows(bucket, start, end, { usageOnly: true })} ON ledger.user_id = gm.user_id
    WHERE ledger.credits_consumed > 0
    GROUP BY gm.group_id, g.name ORDER BY credits_used DESC
  `);
  return { groups: (result.rows as any[]).map((row) => {
    const creditsUsed = Number(row.credits_used ?? 0); const activeUsers = Number(row.active_users ?? 0);
    return { groupId: String(row.group_id), groupName: String(row.group_name), creditsUsed, activeUsers, avgCreditsPerUser: activeUsers ? creditsUsed / activeUsers : 0 };
  }) };
}

export async function getGroupUserBurndowns(timeRange: TimeRange, bucketSize: BucketSize | undefined, groupId: string) {
  const bucket = validateBucketSize(timeRange, bucketSize);
  const { start, end } = getTimeRangeBounds(timeRange);
  const { source, timeColumn, interval } = sourceParts(bucket);
  const members = await db.execute(sql`SELECT gm.user_id, u.username FROM group_members gm JOIN "user" u ON u.id = gm.user_id WHERE gm.group_id = ${groupId} ORDER BY u.username`);
  if (!members.rows.length) return { users: [] as { userId: string; username: string; data: { time: string; balance: number }[] }[] };
  const before = await db.execute(sql`
    SELECT user_id, COALESCE(SUM(credits_added - credits_consumed), 0) AS value FROM ${sql.raw(source)}
    WHERE "${sql.raw(timeColumn)}" < ${start.toISOString()}::timestamptz
      AND user_id IN (SELECT user_id FROM group_members WHERE group_id = ${groupId}) GROUP BY user_id
  `);
  const deltas = await db.execute(sql`
    SELECT time_bucket_gapfill(
      INTERVAL '${sql.raw(interval)}', "${sql.raw(timeColumn)}",
      '${sql.raw(iso(start))}'::timestamptz, '${sql.raw(iso(end))}'::timestamptz
    ) AS bucket, user_id, COALESCE(SUM(credits_added - credits_consumed), 0) AS delta
    FROM ${sql.raw(source)}
    WHERE "${sql.raw(timeColumn)}" >= '${sql.raw(iso(start))}'::timestamptz
      AND "${sql.raw(timeColumn)}" < '${sql.raw(iso(end))}'::timestamptz
      AND user_id IN (SELECT user_id FROM group_members WHERE group_id = ${groupId})
    GROUP BY 1, 2 ORDER BY 1, 2
  `);
  const starts = new Map((before.rows as any[]).map((row) => [String(row.user_id), Number(row.value ?? 0)]));
  const byUser = new Map<string, { time: string; delta: number }[]>();
  for (const row of deltas.rows as any[]) {
    const id = String(row.user_id); const values = byUser.get(id) ?? [];
    values.push({ time: new Date(row.bucket).toISOString(), delta: Number(row.delta ?? 0) }); byUser.set(id, values);
  }
  return { users: (members.rows as any[]).map((member) => {
    const userId = String(member.user_id); let running = starts.get(userId) ?? 0;
    return { userId, username: String(member.username), data: (byUser.get(userId) ?? []).map((entry) => ({ time: entry.time, balance: running += entry.delta })) };
  }) };
}
