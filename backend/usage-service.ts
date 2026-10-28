import { inArray, sql } from "drizzle-orm";
import db from "./db";
import env from "./env";
import { creditEventsTable } from "./schema";
import { nativeMonthlyUsageQuery } from "./usage-budget-query";
import {
  METERED_USAGE_EVENT_TYPES,
  buildLiteLLMDailyActivity,
  buildNativeMonthlyUsage,
  buildPeriodBudget,
  type BudgetUnavailableReason,
  normalizeUsageMetrics,
  parseUtcDailyRange,
  type DailyUsageRow,
  type UsageMetrics,
  type UtcDateRange,
} from "./usage-contract";

interface AggregateRow {
  spend: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_5m_tokens: unknown;
  cache_write_1h_tokens: unknown;
  requests: unknown;
}

interface DailyAggregateRow extends AggregateRow {
  date: Date | string;
  model: string | null;
  api_key_id: string | null;
}

function usageMetrics(row: AggregateRow | undefined): UsageMetrics {
  return normalizeUsageMetrics({
    spend: Number(row?.spend ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWrite5mTokens: Number(row?.cache_write_5m_tokens ?? 0),
    cacheWrite1hTokens: Number(row?.cache_write_1h_tokens ?? 0),
    requests: Number(row?.requests ?? 0),
  });
}

async function aggregateDailyUsage(userId: string, range: UtcDateRange): Promise<DailyUsageRow[]> {
  const result = await db.execute(sql`
    SELECT
      time_bucket(INTERVAL '1 day', ${creditEventsTable.time}) AS date,
      ${creditEventsTable.model} AS model,
      ${creditEventsTable.apiKeyId} AS api_key_id,
      COALESCE(SUM(${creditEventsTable.creditsConsumed}), 0) AS spend,
      COALESCE(SUM(${creditEventsTable.inputTokens}), 0) AS input_tokens,
      COALESCE(SUM(${creditEventsTable.outputTokens}), 0) AS output_tokens,
      COALESCE(SUM(${creditEventsTable.cacheReadTokens}), 0) AS cache_read_tokens,
      COALESCE(SUM(${creditEventsTable.cacheWrite5mTokens}), 0) AS cache_write_5m_tokens,
      COALESCE(SUM(${creditEventsTable.cacheWrite1hTokens}), 0) AS cache_write_1h_tokens,
      COUNT(*) AS requests
    FROM ${creditEventsTable}
    WHERE ${creditEventsTable.userId} = ${userId}
      AND ${creditEventsTable.time} >= ${range.start}
      AND ${creditEventsTable.time} < ${range.endExclusive}
      AND ${inArray(creditEventsTable.type, [...METERED_USAGE_EVENT_TYPES])}
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, 2, 3
  `);
  return (result.rows as unknown as DailyAggregateRow[]).map((row) => ({
    date: new Date(row.date).toISOString().slice(0, 10),
    model: row.model,
    apiKeyId: row.api_key_id,
    ...usageMetrics(row),
  }));
}

export async function getNativeMonthlyUsage(params: { userId: string }) {
  // Do not accept a balance/allocation read by the caller: all related amounts
  // must come from this statement's snapshot, including legacy fields.
  const result = await db.execute(nativeMonthlyUsageQuery(params.userId));
  const row = result.rows[0];
  if (!row) return null;
  const start = new Date(row.period_start as string | Date);
  const endExclusive = new Date(row.period_end as string | Date);
  const balance = Number(row.balance);
  const spend = Number(row.spend);
  return {
    ...buildNativeMonthlyUsage({
      dashboardUrl: new URL("/profile", env.BASE_URL).href,
      range: {
        start, endExclusive,
        startDate: start.toISOString().slice(0, 10),
        endDate: new Date(endExclusive.getTime() - 86_400_000).toISOString().slice(0, 10),
      },
      balance,
      monthlyAllocation: Number(row.monthly_allocation),
      metrics: usageMetrics(row as unknown as AggregateRow),
    }),
    observed_at: new Date(row.observed_at as string | Date).toISOString(),
    budget: buildPeriodBudget({
      opening_balance: Number(row.opening_balance),
      top_ups: Number(row.top_ups),
      adjustment_removals: Number(row.adjustment_removals),
      reset_additions: Number(row.reset_additions),
      reset_removals: Number(row.reset_removals),
      net_funding: Number(row.net_funding),
      effective_budget: Number(row.effective_budget),
    }, spend, balance, row.unavailable_reason as BudgetUnavailableReason | null),
  };
}

export async function getLiteLLMDailyActivity(params: {
  userId: string;
  startDate: string | null;
  endDate: string | null;
}) {
  const range = parseUtcDailyRange(params.startDate, params.endDate);
  return buildLiteLLMDailyActivity(await aggregateDailyUsage(params.userId, range));
}
