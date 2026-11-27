import { sql, type SQL } from "drizzle-orm";
import db from "./db";
import {
  BUCKET_SIZES,
  getBucketOptions,
  getWindowBounds,
  validateBucketSize,
  type AnalyticsWindow,
  type BucketSize,
} from "../shared/analytics-time-ranges";
import { bucketFloor, wholeBucketEnd, wholeBucketStart, type AggregateTable } from "./analytics-window";
import { scopeSql, selectedGroupsSql, type AnalyticsScope } from "./analytics-scope";

export {
  ALLOWED_BUCKETS,
  getTimeRangeBounds,
  getWindowBounds,
  parseAnalyticsWindow,
  validateBucketSize,
  validateTimeRange,
  type AnalyticsWindow,
  type BucketSize,
  type CustomTimeRange,
  type TimeRange,
} from "../shared/analytics-time-ranges";
export { analyticsScope, type AnalyticsScope } from "./analytics-scope";
type SourceTable = "credit_events" | AggregateTable;

export function getBucketInterval(bucketSize: BucketSize): string {
  return BUCKET_SIZES[bucketSize].interval;
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

function usageOnlySql(source: SourceTable): SQL {
  if (source === "credit_events") return sql`AND type IN ('usage', 'chat', 'api', 'embedding')`;
  return sql`AND model IS NOT NULL`;
}

/** The window's bounds and its validated chart interval. */
function resolve(window: AnalyticsWindow, bucketSize?: string | null) {
  return { ...getWindowBounds(window), bucket: validateBucketSize(window, bucketSize) };
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
const LEDGER_COLUMNS = sql.raw("user_id, model, credits_added, credits_consumed, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens");

function timeFilter(table: SourceTable, from: Date, to: Date): SQL {
  const column = sql.raw(`"${getTimeColumn(table)}"`);
  return sql`${column} >= '${sql.raw(iso(from))}'::timestamptz AND ${column} < '${sql.raw(iso(to))}'::timestamptz`;
}

/**
 * The ledger in [start, end) as a FROM-clause subquery named "ledger" with a
 * "time" column. Aggregate-backed intervals read the window's partial first
 * and last aggregate buckets from credit_events, because those buckets also
 * hold events from outside the window: filtering on the bucket start would drop
 * the first bucket's in-window events, such as the first day of "Last 7 days",
 * and keep the last bucket's events after a custom window's end. Whole buckets
 * come from the continuous aggregate, which answers buckets that its refresh
 * policy has not materialized yet in real time (drizzle/0006_realtime_credit_aggregates.sql).
 */
function ledgerRows(bucket: BucketSize, start: Date, end: Date, filter: { scope?: AnalyticsScope; usageOnly?: boolean } = {}): SQL {
  const source = getSourceTable(bucket);
  const where = (table: SourceTable, from: Date, to: Date) =>
    sql`WHERE ${timeFilter(table, from, to)} ${scopeSql(filter.scope)} ${filter.usageOnly ? usageOnlySql(table) : sql``}`;
  const raw = (from: Date, to: Date) => sql`SELECT "time", ${LEDGER_COLUMNS} FROM credit_events ${where("credit_events", from, to)}`;
  if (source === "credit_events") return sql`(${raw(start, end)}) AS ledger`;
  const aggregateStart = wholeBucketStart(source, start, end);
  const aggregateEnd = wholeBucketEnd(source, start, end);
  return sql`(
    ${raw(start, aggregateStart)}
    UNION ALL
    SELECT bucket AS "time", ${LEDGER_COLUMNS} FROM ${sql.raw(source)} ${where(source, aggregateStart, aggregateEnd)}
    UNION ALL
    ${raw(aggregateEnd, end)}
  ) AS ledger`;
}

/**
 * The whole ledger before `start` as a FROM-clause subquery named "opening":
 * whole days from the daily aggregate, the rest of the day from credit_events.
 * Its sum of credits_added - credits_consumed is the balance at `start`.
 */
function ledgerBefore(start: Date, scope?: AnalyticsScope): SQL {
  const dayStart = bucketFloor("credit_events_1d", start);
  return sql`(
    SELECT user_id, credits_added, credits_consumed FROM credit_events_1d
    WHERE bucket < '${sql.raw(iso(dayStart))}'::timestamptz ${scopeSql(scope)}
    UNION ALL
    SELECT user_id, credits_added, credits_consumed FROM credit_events
    WHERE ${timeFilter("credit_events", dayStart, start)} ${scopeSql(scope)}
  ) AS opening`;
}

export async function getCreditsConsumed(window: AnalyticsWindow, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const { start, end, bucket } = resolve(window, bucketSize);
  const result = await db.execute(sql`
    SELECT ${gapfill(bucket, start, end)} AS bucket, COALESCE(SUM(credits_consumed), 0) AS consumed
    FROM ${ledgerRows(bucket, start, end, { scope, usageOnly: true })}
    GROUP BY 1 ORDER BY 1
  `);
  return (result.rows as any[]).map((row) => ({ time: new Date(row.bucket).toISOString(), consumed: Number(row.consumed ?? 0) }));
}

/** Total current balance of the scope's users, each counted once. */
async function currentBalance(scope?: AnalyticsScope): Promise<number> {
  const result = await db.execute(sql`SELECT COALESCE(SUM(credit_balance), 0) AS value FROM "user" WHERE true ${scopeSql(scope, sql.raw("id"))}`);
  return Number((result.rows[0] as any)?.value ?? 0);
}

/**
 * Balance after each bucket: the balance at the window's start plus the
 * window's ledger up to the end of the bucket, or up to the window's end for
 * the last one. A rolling window ends now, so its last point is the current
 * balance; a custom window's last point is the balance at its end.
 */
export async function getBalanceBurndown(window: AnalyticsWindow, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const { start, end, bucket } = resolve(window, bucketSize);
  const [balance, opening, deltas] = await Promise.all([
    currentBalance(scope),
    db.execute(sql`SELECT COALESCE(SUM(credits_added - credits_consumed), 0) AS value FROM ${ledgerBefore(start, scope)}`),
    db.execute(sql`
      SELECT ${gapfill(bucket, start, end)} AS bucket, COALESCE(SUM(credits_added - credits_consumed), 0) AS delta
      FROM ${ledgerRows(bucket, start, end, { scope })}
      GROUP BY 1 ORDER BY 1
    `),
  ]);
  let running = Number((opening.rows[0] as any)?.value ?? 0);
  const data = (deltas.rows as any[]).map((row) => ({ time: new Date(row.bucket).toISOString(), balance: running += Number(row.delta ?? 0) }));
  return { data, currentBalance: balance };
}

export async function getUsageByModel(window: AnalyticsWindow, bucketSize?: BucketSize, scope?: AnalyticsScope, topN = 5) {
  const { start, end, bucket } = resolve(window, bucketSize);
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

export async function getTokensConsumed(window: AnalyticsWindow, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const { start, end, bucket } = resolve(window, bucketSize);
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

export async function getModelSummary(window: AnalyticsWindow, bucketSize?: BucketSize, scope?: AnalyticsScope) {
  const { start, end, bucket } = resolve(window, bucketSize);
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

export async function getUserSummary(window: AnalyticsWindow, scope?: AnalyticsScope) {
  const { start, end } = getWindowBounds(window);
  const bucket = getBucketOptions(window).default;
  const result = await db.execute(sql`
    SELECT ledger.user_id, u.username, SUM(ledger.credits_consumed) AS credits_used,
      COUNT(DISTINCT DATE(ledger."time")) AS active_days, MAX(ledger."time") AS last_activity
    FROM ${ledgerRows(bucket, start, end, { scope, usageOnly: true })}
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

/**
 * Usage per group of its current members. With selected groups, only those
 * groups; with selected users only, the groups they belong to. Either way only
 * the usage of the scope's users counts.
 */
export async function getGroupSummary(window: AnalyticsWindow, scope?: AnalyticsScope) {
  const { start, end } = getWindowBounds(window);
  const bucket = getBucketOptions(window).default;
  const result = await db.execute(sql`
    SELECT gm.group_id, g.name AS group_name, SUM(ledger.credits_consumed) AS credits_used,
      COUNT(DISTINCT ledger.user_id) AS active_users
    FROM group_members gm JOIN groups g ON g.id = gm.group_id
      JOIN ${ledgerRows(bucket, start, end, { scope, usageOnly: true })} ON ledger.user_id = gm.user_id
    WHERE ledger.credits_consumed > 0 ${selectedGroupsSql(scope, sql.raw("gm.group_id"))}
    GROUP BY gm.group_id, g.name ORDER BY credits_used DESC
  `);
  return { groups: (result.rows as any[]).map((row) => {
    const creditsUsed = Number(row.credits_used ?? 0); const activeUsers = Number(row.active_users ?? 0);
    return { groupId: String(row.group_id), groupName: String(row.group_name), creditsUsed, activeUsers, avgCreditsPerUser: activeUsers ? creditsUsed / activeUsers : 0 };
  }) };
}

/**
 * Each current member's balance after each bucket, as getBalanceBurndown
 * computes it. Members without ledger events in the window keep their opening
 * balance at every bucket.
 */
export async function getGroupUserBurndowns(window: AnalyticsWindow, bucketSize: BucketSize | undefined, groupId: string) {
  const { start, end, bucket } = resolve(window, bucketSize);
  const scope: AnalyticsScope = { groupIds: [groupId] };
  const members = await db.execute(sql`SELECT gm.user_id, u.username FROM group_members gm JOIN "user" u ON u.id = gm.user_id WHERE gm.group_id = ${groupId} ORDER BY u.username`);
  if (!members.rows.length) return { users: [] as { userId: string; username: string; data: { time: string; balance: number }[] }[] };
  const [opening, deltas] = await Promise.all([
    db.execute(sql`SELECT user_id, COALESCE(SUM(credits_added - credits_consumed), 0) AS value FROM ${ledgerBefore(start, scope)} GROUP BY user_id`),
    db.execute(sql`
      SELECT ${gapfill(bucket, start, end)} AS bucket, user_id, COALESCE(SUM(credits_added - credits_consumed), 0) AS delta
      FROM ${ledgerRows(bucket, start, end, { scope })}
      GROUP BY 1, 2 ORDER BY 1, 2
    `),
  ]);
  const starts = new Map((opening.rows as any[]).map((row) => [String(row.user_id), Number(row.value ?? 0)]));
  const times: string[] = [];
  const changes = new Map<string, number>();
  for (const row of deltas.rows as any[]) {
    const time = new Date(row.bucket).toISOString();
    if (times.at(-1) !== time) times.push(time);
    changes.set(`${row.user_id}\u0000${time}`, Number(row.delta ?? 0));
  }
  return { users: (members.rows as any[]).map((member) => {
    const userId = String(member.user_id); let running = starts.get(userId) ?? 0;
    return { userId, username: String(member.username), data: times.map((time) => ({ time, balance: running += changes.get(`${userId}\u0000${time}`) ?? 0 })) };
  }) };
}
