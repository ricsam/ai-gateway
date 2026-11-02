// Pure throughput calculations. The SQL in throughput-service.ts aggregates the
// ledger; these helpers derive the reported rates, so they can be tested without
// a database.

export const THROUGHPUT_HOUR_MS = 60 * 60 * 1000;

/**
 * Throughput of metered inference requests in a time window.
 *
 * Tokens follow Amazon Bedrock's tokens-per-minute (TPM) quota accounting:
 * uncached input + cache writes + output. Cache reads are excluded because
 * Bedrock does not count them toward TPM quotas. Output burndown multipliers,
 * which Bedrock applies per model, are not included.
 */
export interface ThroughputStats {
  /** Metered inference requests. */
  requests: number;
  /** Input, cache-write and output tokens of those requests. */
  tokens: number;
  /** One-hour periods of the window, counted from its start, that had at least one request. */
  activeHours: number;
  /** tokens / (60 × activeHours): the average TPM across the hours with traffic. */
  steadyStateTpm: number;
  /** requests / (60 × activeHours): the average RPM across the hours with traffic. */
  steadyStateRpm: number;
  /** Tokens in the busiest UTC-aligned calendar minute. */
  peakTpm: number;
  /** Start of that minute, or null without tokens. */
  peakTpmAt: string | null;
  /** Requests in the busiest UTC-aligned calendar minute. */
  peakRpm: number;
  /** Start of that minute, or null without requests. */
  peakRpmAt: string | null;
  /** (Uncached input + cache writes) / requests. */
  avgInputTokensPerRequest: number;
  /** Output tokens / requests. */
  avgOutputTokensPerRequest: number;
  /** Cache reads / requests. Informational: excluded from TPM and the average input. */
  avgCacheReadTokensPerRequest: number;
}

export interface ModelThroughputStats extends ThroughputStats {
  /** Upstream model as recorded in the ledger; null for legacy requests without a model. */
  model: string | null;
}

/** Aggregates of one scope (all models or one model) as read from the database. */
export interface ThroughputAggregate {
  requests: unknown;
  /** Uncached input plus cache writes. */
  inputTokens: unknown;
  outputTokens: unknown;
  cacheReadTokens: unknown;
  activeHours: unknown;
  peakRequests: unknown;
  peakRequestsAt: Date | string | null | undefined;
  peakTokens: unknown;
  peakTokensAt: Date | string | null | undefined;
}

/**
 * Number of one-hour periods in [start, end). Steady-state rates divide by the
 * periods that had traffic, so the window must consist of whole periods; every
 * analytics time range does.
 */
export function throughputPeriodCount(start: Date, end: Date): number {
  const hours = (end.getTime() - start.getTime()) / THROUGHPUT_HOUR_MS;
  if (!Number.isInteger(hours) || hours < 1) throw new Error("Throughput windows must span a whole number of hours");
  return hours;
}

function count(value: unknown): number {
  // PostgreSQL returns bigint and numeric aggregates as strings.
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function timestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function emptyThroughputStats(): ThroughputStats {
  return {
    requests: 0, tokens: 0, activeHours: 0,
    steadyStateTpm: 0, steadyStateRpm: 0,
    peakTpm: 0, peakTpmAt: null, peakRpm: 0, peakRpmAt: null,
    avgInputTokensPerRequest: 0, avgOutputTokensPerRequest: 0, avgCacheReadTokensPerRequest: 0,
  };
}

export function throughputStats(aggregate: ThroughputAggregate): ThroughputStats {
  const requests = count(aggregate.requests);
  const inputTokens = count(aggregate.inputTokens);
  const outputTokens = count(aggregate.outputTokens);
  const cacheReadTokens = count(aggregate.cacheReadTokens);
  const activeHours = count(aggregate.activeHours);
  const peakRpm = count(aggregate.peakRequests);
  const peakTpm = count(aggregate.peakTokens);
  const tokens = inputTokens + outputTokens;
  const activeMinutes = activeHours * 60;
  return {
    requests,
    tokens,
    activeHours,
    steadyStateTpm: activeMinutes ? tokens / activeMinutes : 0,
    steadyStateRpm: activeMinutes ? requests / activeMinutes : 0,
    peakTpm,
    peakTpmAt: peakTpm ? timestamp(aggregate.peakTokensAt) : null,
    peakRpm,
    peakRpmAt: peakRpm ? timestamp(aggregate.peakRequestsAt) : null,
    avgInputTokensPerRequest: requests ? inputTokens / requests : 0,
    avgOutputTokensPerRequest: requests ? outputTokens / requests : 0,
    avgCacheReadTokensPerRequest: requests ? cacheReadTokens / requests : 0,
  };
}
