export const METERED_USAGE_EVENT_TYPES = ["usage", "chat", "api", "embedding"] as const;

export type MeteredUsageEventType = (typeof METERED_USAGE_EVENT_TYPES)[number];

export class UsageValidationError extends Error {
  constructor(message: string, public readonly param: "start_date" | "end_date" | null = null) {
    super(message);
    this.name = "UsageValidationError";
  }
}

export interface UtcDateRange {
  start: Date;
  endExclusive: Date;
  startDate: string;
  endDate: string;
}

export interface UsageMetrics {
  spend: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  requests: number;
}

export interface DailyUsageRow extends UsageMetrics {
  date: string;
  model: string | null;
  apiKeyId: string | null;
}

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDate(value: string, param: "start_date" | "end_date"): Date {
  const match = DATE_ONLY.exec(value);
  if (!match || match[1] === "0000") {
    throw new UsageValidationError(`${param} must be a valid date in YYYY-MM-DD format`, param);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new UsageValidationError(`${param} must be a valid date in YYYY-MM-DD format`, param);
  }
  return date;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseUtcDailyRange(startDate: string | null, endDate: string | null): UtcDateRange {
  if (!startDate) throw new UsageValidationError("start_date is required", "start_date");
  if (!endDate) throw new UsageValidationError("end_date is required", "end_date");
  const start = utcDate(startDate, "start_date");
  const inclusiveEnd = utcDate(endDate, "end_date");
  if (inclusiveEnd < start) {
    throw new UsageValidationError("end_date must be on or after start_date", "end_date");
  }
  const inclusiveDays = Math.round((inclusiveEnd.getTime() - start.getTime()) / DAY_MS) + 1;
  if (inclusiveDays > 366) {
    throw new UsageValidationError("Date range cannot exceed 366 inclusive UTC days");
  }
  const endExclusive = new Date(inclusiveEnd.getTime() + DAY_MS);
  if (!Number.isFinite(endExclusive.getTime())) {
    throw new UsageValidationError("end_date is outside the supported range", "end_date");
  }
  return { start, endExclusive, startDate, endDate };
}

export function currentUtcMonthRange(now = new Date()): UtcDateRange {
  if (!Number.isFinite(now.getTime())) throw new UsageValidationError("Current time is invalid");
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    start,
    endExclusive,
    startDate: dateOnly(start),
    endDate: dateOnly(new Date(endExclusive.getTime() - DAY_MS)),
  };
}

export function isMeteredUsageEventType(value: string): value is MeteredUsageEventType {
  return (METERED_USAGE_EVENT_TYPES as readonly string[]).includes(value);
}

export function emptyUsageMetrics(): UsageMetrics {
  return {
    spend: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    requests: 0,
  };
}

function finite(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeUsageMetrics(value: Partial<UsageMetrics>): UsageMetrics {
  return {
    spend: finite(value.spend),
    inputTokens: finite(value.inputTokens),
    outputTokens: finite(value.outputTokens),
    cacheReadTokens: finite(value.cacheReadTokens),
    cacheWrite5mTokens: finite(value.cacheWrite5mTokens),
    cacheWrite1hTokens: finite(value.cacheWrite1hTokens),
    requests: finite(value.requests),
  };
}

function totalTokens(metrics: UsageMetrics): number {
  return metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens
    + metrics.cacheWrite5mTokens + metrics.cacheWrite1hTokens;
}

function liteLLMMetrics(metrics: UsageMetrics) {
  return {
    spend: metrics.spend,
    prompt_tokens: metrics.inputTokens,
    completion_tokens: metrics.outputTokens,
    total_tokens: metrics.inputTokens + metrics.outputTokens,
    cache_read_input_tokens: metrics.cacheReadTokens,
    cache_creation_input_tokens: metrics.cacheWrite5mTokens + metrics.cacheWrite1hTokens,
    api_requests: metrics.requests,
  };
}

function addMetrics(target: UsageMetrics, source: UsageMetrics): void {
  target.spend += source.spend;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWrite5mTokens += source.cacheWrite5mTokens;
  target.cacheWrite1hTokens += source.cacheWrite1hTokens;
  target.requests += source.requests;
}

interface BreakdownEntry {
  metrics: UsageMetrics;
  metadata: Record<string, unknown>;
}

interface DayAccumulator {
  metrics: UsageMetrics;
  models: Map<string, BreakdownEntry>;
  providers: Map<string, BreakdownEntry>;
  apiKeys: Map<string, BreakdownEntry>;
}

function addBreakdown(
  values: Map<string, BreakdownEntry>,
  key: string,
  metrics: UsageMetrics,
  metadata: Record<string, unknown> = {},
): void {
  const entry = values.get(key) ?? { metrics: emptyUsageMetrics(), metadata };
  addMetrics(entry.metrics, metrics);
  values.set(key, entry);
}

function breakdownObject(values: Map<string, BreakdownEntry>) {
  return Object.fromEntries([...values.entries()].map(([key, value]) => [key, {
    metrics: liteLLMMetrics(value.metrics),
    metadata: value.metadata,
  }]));
}

export function buildNativeMonthlyUsage(params: {
  range: UtcDateRange;
  balance: number;
  monthlyAllocation: number;
  metrics: UsageMetrics;
}) {
  const metrics = normalizeUsageMetrics(params.metrics);
  const allocation = finite(params.monthlyAllocation);
  const balance = finite(params.balance);
  return {
    object: "usage_summary",
    currency: "USD",
    period: {
      start: params.range.start.toISOString(),
      end: params.range.endExclusive.toISOString(),
      timezone: "UTC",
    },
    credits: {
      used: metrics.spend,
      balance,
      monthly_allocation: allocation,
      percent_used: allocation > 0 ? metrics.spend / allocation * 100 : null,
    },
    requests: metrics.requests,
    tokens: {
      input: metrics.inputTokens,
      output: metrics.outputTokens,
      cache_read: metrics.cacheReadTokens,
      cache_write_5m: metrics.cacheWrite5mTokens,
      cache_write_1h: metrics.cacheWrite1hTokens,
      cache_write: metrics.cacheWrite5mTokens + metrics.cacheWrite1hTokens,
      total: totalTokens(metrics),
    },
  };
}

export function buildLiteLLMDailyActivity(rows: DailyUsageRow[]) {
  const days = new Map<string, DayAccumulator>();
  const totals = emptyUsageMetrics();

  for (const row of rows) {
    const metrics = normalizeUsageMetrics(row);
    const day = days.get(row.date) ?? {
      metrics: emptyUsageMetrics(),
      models: new Map(),
      providers: new Map(),
      apiKeys: new Map(),
    };
    addMetrics(day.metrics, metrics);
    addMetrics(totals, metrics);
    addBreakdown(day.models, row.model ?? "unknown", metrics);
    addBreakdown(day.providers, "bedrock", metrics);
    const keyId = row.apiKeyId ?? "playground";
    addBreakdown(day.apiKeys, keyId, metrics, {
      key_alias: row.apiKeyId ? null : "playground",
      team_id: null,
    });
    days.set(row.date, day);
  }

  const results = [...days.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, day]) => ({
      date,
      metrics: liteLLMMetrics(day.metrics),
      breakdown: {
        models: breakdownObject(day.models),
        providers: breakdownObject(day.providers),
        api_keys: breakdownObject(day.apiKeys),
      },
    }));

  return {
    results,
    metadata: {
      total_spend: totals.spend,
      total_prompt_tokens: totals.inputTokens,
      total_completion_tokens: totals.outputTokens,
      total_tokens: totals.inputTokens + totals.outputTokens,
      total_api_requests: totals.requests,
      total_cache_read_input_tokens: totals.cacheReadTokens,
      total_cache_creation_input_tokens: totals.cacheWrite5mTokens + totals.cacheWrite1hTokens,
      page: 1,
      total_pages: 1,
      has_more: false,
    },
  };
}
