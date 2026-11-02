import { sql } from "drizzle-orm";
import db from "./db";
import { getTimeRangeBounds, type TimeRange } from "../shared/analytics-time-ranges";
import { METERED_USAGE_EVENT_TYPES } from "./usage-contract";
import {
  emptyThroughputStats, throughputPeriodCount, throughputStats,
  type ModelThroughputStats, type ThroughputStats,
} from "./throughput-stats";

export type { ModelThroughputStats, ThroughputStats } from "./throughput-stats";
export type ThroughputScope = { userId?: string; groupId?: string };

export interface ThroughputReport {
  start: string;
  end: string;
  /** All models together: peaks are the busiest minutes across every model. */
  summary: ThroughputStats;
  /** Ordered by tokens, then requests. */
  models: ModelThroughputStats[];
}

interface ThroughputRow {
  all_models: boolean;
  model: string | null;
  requests: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  active_hours: string;
  peak_requests: string | null;
  peak_requests_at: Date | string | null;
  peak_tokens: string | null;
  peak_tokens_at: Date | string | null;
}

function scopeSql(scope: ThroughputScope | undefined) {
  if (scope?.userId) return sql`AND user_id = ${scope.userId}`;
  if (scope?.groupId) return sql`AND user_id IN (SELECT user_id FROM group_members WHERE group_id = ${scope.groupId})`;
  return sql``;
}

/**
 * Steady-state and peak tokens and requests per minute, and average tokens per
 * request, of metered inference in a rolling window, overall and per model.
 *
 * Reads the raw ledger: peaks need one-minute resolution and the continuous
 * aggregates have neither that nor request counts. Minutes are UTC-aligned
 * calendar minutes. Steady state averages the window's one-hour periods,
 * counted from its start, that had at least one request, so idle hours (nights,
 * weekends) do not dilute it and the Last 60 minutes range is a single period.
 */
export async function getThroughput(timeRange: TimeRange, scope?: ThroughputScope, now = new Date()): Promise<ThroughputReport> {
  const { start, end } = getTimeRangeBounds(timeRange, now);
  throughputPeriodCount(start, end);
  const startAt = start.toISOString();
  const endAt = end.toISOString();
  const meteredTypes = sql.join(METERED_USAGE_EVENT_TYPES.map((type) => sql`${type}`), sql`, `);
  const metered = sql`"time" >= ${startAt}::timestamptz AND "time" < ${endAt}::timestamptz
    AND type IN (${meteredTypes}) ${scopeSql(scope)}`;
  const result = await db.transaction(async (tx) => {
    // PostgreSQL cannot estimate the number of per-minute groups and tends to
    // choose per-chunk sorts that spill to disk. Hash aggregation measured two
    // to three times faster on large ledgers. Applies to this transaction only.
    await tx.execute(sql`SET LOCAL enable_sort = off`);
    return tx.execute(sql`
      WITH hourly AS (
        SELECT model, time_bucket(INTERVAL '1 hour', "time", ${startAt}::timestamptz) AS hour,
          count(*) AS requests,
          sum(input_tokens::bigint + cache_write_5m_tokens + cache_write_1h_tokens) AS input_tokens,
          sum(output_tokens::bigint) AS output_tokens,
          sum(cache_read_tokens::bigint) AS cache_read_tokens
        FROM credit_events WHERE ${metered}
        GROUP BY 1, 2
      ),
      minutes AS (
        SELECT model, time_bucket(INTERVAL '1 minute', "time") AS minute, count(*) AS requests,
          sum(input_tokens::bigint + cache_write_5m_tokens + cache_write_1h_tokens + output_tokens)::bigint AS tokens
        FROM credit_events WHERE ${metered}
        GROUP BY 1, 2
      ),
      -- max() of [value, epoch] arrays is the busiest minute, the most recent one on ties.
      model_peaks AS (
        SELECT model,
          max(ARRAY[requests, date_part('epoch', minute)::bigint]) AS peak_requests,
          max(ARRAY[tokens, date_part('epoch', minute)::bigint]) AS peak_tokens
        FROM minutes GROUP BY model
      ),
      overall_peaks AS (
        SELECT max(ARRAY[requests, epoch]) AS peak_requests, max(ARRAY[tokens, epoch]) AS peak_tokens
        FROM (
          SELECT date_part('epoch', minute)::bigint AS epoch, sum(requests)::bigint AS requests, sum(tokens)::bigint AS tokens
          FROM minutes GROUP BY minute
        ) per_minute
      ),
      model_totals AS (
        SELECT model, sum(requests) AS requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
          sum(cache_read_tokens) AS cache_read_tokens, count(*) AS active_hours
        FROM hourly GROUP BY model
      )
      SELECT * FROM (
        SELECT false AS all_models, t.model, t.requests, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.active_hours,
          p.peak_requests[1] AS peak_requests, to_timestamp(p.peak_requests[2]) AS peak_requests_at,
          p.peak_tokens[1] AS peak_tokens, to_timestamp(p.peak_tokens[2]) AS peak_tokens_at
        FROM model_totals t JOIN model_peaks p ON p.model IS NOT DISTINCT FROM t.model
        UNION ALL
        SELECT true, NULL, sum(requests), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), count(DISTINCT hour),
          (SELECT peak_requests[1] FROM overall_peaks), (SELECT to_timestamp(peak_requests[2]) FROM overall_peaks),
          (SELECT peak_tokens[1] FROM overall_peaks), (SELECT to_timestamp(peak_tokens[2]) FROM overall_peaks)
        FROM hourly HAVING count(*) > 0
      ) throughput
      ORDER BY all_models DESC, input_tokens + output_tokens DESC, requests DESC, model NULLS LAST
    `);
  });
  let summary = emptyThroughputStats();
  const models: ModelThroughputStats[] = [];
  for (const row of result.rows as unknown as ThroughputRow[]) {
    const stats = throughputStats({
      requests: row.requests, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens, activeHours: row.active_hours,
      peakRequests: row.peak_requests, peakRequestsAt: row.peak_requests_at,
      peakTokens: row.peak_tokens, peakTokensAt: row.peak_tokens_at,
    });
    if (row.all_models) summary = stats;
    else models.push({ model: row.model, ...stats });
  }
  return { start: startAt, end: endAt, summary, models };
}
