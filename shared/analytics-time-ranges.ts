// Keep these values stable: they are API parameters and saved browser preferences.
export type TimeRange = "hour" | "day" | "week" | "month" | "quarter" | "year";
export type BucketSize = "15s" | "1m" | "5m" | "30m" | "1h" | "1d" | "1w" | "1mo";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// These are elapsed-time windows ending now, not current calendar periods.
export const TIME_RANGES: Record<TimeRange, { label: string; durationMs: number }> = {
  hour: { label: "Last 60 minutes", durationMs: HOUR_MS },
  day: { label: "Last 24 hours", durationMs: DAY_MS },
  week: { label: "Last 7 days", durationMs: 7 * DAY_MS },
  month: { label: "Last 30 days", durationMs: 30 * DAY_MS },
  quarter: { label: "Last 90 days", durationMs: 90 * DAY_MS },
  year: { label: "Last 365 days", durationMs: 365 * DAY_MS },
};

/** A window chosen by its own start and end: [start, end), so `end` itself is not included. */
export interface CustomTimeRange {
  start: Date;
  end: Date;
}

/** What analytics cover: a rolling window ending now, or a custom window. */
export type AnalyticsWindow = TimeRange | CustomTimeRange;

/** Rejected analytics input: the request, not the server, is at fault. */
export class AnalyticsQueryError extends Error {
  override name = "AnalyticsQueryError";
}

export function isTimeRange(value: unknown): value is TimeRange {
  return typeof value === "string" && Object.hasOwn(TIME_RANGES, value);
}

export function getTimeRangeBounds(timeRange: TimeRange, now = new Date()): { start: Date; end: Date } {
  const end = new Date(now);
  // Timestamp arithmetic avoids calendar overflow, leap-year and DST changes.
  const start = new Date(end.getTime() - TIME_RANGES[timeRange].durationMs);
  return { start, end };
}

export function getWindowBounds(window: AnalyticsWindow, now = new Date()): { start: Date; end: Date } {
  if (typeof window === "string") return getTimeRangeBounds(window, now);
  return { start: new Date(window.start), end: new Date(window.end) };
}

export const BUCKET_SIZES: Record<BucketSize, { label: string; interval: string; durationMs: number }> = {
  "15s": { label: "15 seconds", interval: "15 seconds", durationMs: 15 * 1000 },
  "1m": { label: "1 minute", interval: "1 minute", durationMs: MINUTE_MS },
  "5m": { label: "5 minutes", interval: "5 minutes", durationMs: 5 * MINUTE_MS },
  "30m": { label: "30 minutes", interval: "30 minutes", durationMs: 30 * MINUTE_MS },
  "1h": { label: "1 hour", interval: "1 hour", durationMs: HOUR_MS },
  "1d": { label: "1 day", interval: "1 day", durationMs: DAY_MS },
  "1w": { label: "1 week", interval: "1 week", durationMs: 7 * DAY_MS },
  // Calendar months vary; this average only sizes custom windows.
  "1mo": { label: "1 month", interval: "1 month", durationMs: 30.436875 * DAY_MS },
};
const BUCKET_ORDER = Object.keys(BUCKET_SIZES) as BucketSize[];

export const ALLOWED_BUCKETS: Record<TimeRange, { allowed: BucketSize[]; default: BucketSize }> = {
  hour: { allowed: ["15s", "1m", "5m"], default: "5m" },
  day: { allowed: ["5m", "30m", "1h"], default: "1h" },
  week: { allowed: ["1d"], default: "1d" },
  month: { allowed: ["1d", "1w"], default: "1d" },
  quarter: { allowed: ["1w"], default: "1w" },
  year: { allowed: ["1mo"], default: "1mo" },
};

export const MIN_CUSTOM_RANGE_MS = MINUTE_MS;
// Ten years, leap days included.
export const MAX_CUSTOM_RANGE_MS = 3653 * DAY_MS;
/** Most buckets a custom window's interval may produce, so charts and gap-filling stay small. */
export const MAX_CUSTOM_BUCKETS = 400;
// Rolling presets default to 7-30 buckets; custom windows default to the interval closest to this.
const TARGET_CUSTOM_BUCKETS = 24;

/**
 * The intervals a window can be charted at. Rolling presets keep their fixed
 * lists. A custom window allows every interval that is no longer than the
 * window and gives at most MAX_CUSTOM_BUCKETS buckets, and defaults to the one
 * whose bucket count is closest to about two dozen, the finer one on ties.
 * Applied to the presets' durations, that rule picks the presets' defaults.
 */
export function getBucketOptions(window: AnalyticsWindow): { allowed: BucketSize[]; default: BucketSize } {
  if (typeof window === "string") return ALLOWED_BUCKETS[window];
  const durationMs = window.end.getTime() - window.start.getTime();
  const buckets = (size: BucketSize) => Math.ceil(durationMs / BUCKET_SIZES[size].durationMs);
  const allowed = BUCKET_ORDER.filter(
    (size) => BUCKET_SIZES[size].durationMs <= durationMs && buckets(size) <= MAX_CUSTOM_BUCKETS,
  );
  // Windows shorter than 15 seconds are rejected before this; keep a usable answer anyway.
  if (!allowed.length) return { allowed: ["15s"], default: "15s" };
  const distance = (size: BucketSize) => Math.abs(Math.log(buckets(size) / TARGET_CUSTOM_BUCKETS));
  const preferred = allowed.reduce((best, size) => (distance(size) < distance(best) ? size : best));
  return { allowed, default: preferred };
}

export function validateTimeRange(value: string | null | undefined): TimeRange {
  if (!value) return "month";
  if (isTimeRange(value)) return value;
  throw new AnalyticsQueryError(`Invalid time range "${value}". Allowed: ${Object.keys(TIME_RANGES).join(", ")}, or start and end`);
}

export function validateBucketSize(window: AnalyticsWindow, bucketSize?: string | null): BucketSize {
  const options = getBucketOptions(window);
  if (!bucketSize) return options.default;
  if (options.allowed.includes(bucketSize as BucketSize)) return bucketSize as BucketSize;
  const subject = typeof window === "string" ? `time range "${window}"` : "this custom time range";
  throw new AnalyticsQueryError(`Invalid bucket size "${bucketSize}" for ${subject}. Allowed: ${options.allowed.join(", ")}`);
}

// A date (UTC midnight), or a date and time with Z or a UTC offset. Times without
// an offset are refused: they would be read in the server's time zone.
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2})))?$/;

/** Parses an ISO 8601 instant; field-checked, so 2026-02-30 is refused instead of rolling over. */
export function parseInstant(value: string, name = "time"): Date {
  // An unencoded "+" in a query string arrives as a space.
  const match = INSTANT.exec(value.trim().replace(/ (\d{2}:\d{2})$/, "+$1"));
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction = "0", zone, sign, offsetHour, offsetMinute] =
    match ?? [];
  const fields = [year, month, day, hour, minute, second].map(Number) as [number, number, number, number, number, number];
  const [y, mo, d, h, mi, s] = fields;
  const valid =
    match &&
    y >= 1970 &&
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() &&
    h <= 23 &&
    mi <= 59 &&
    s <= 59 &&
    (zone === undefined || zone === "Z" || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
  if (!valid)
    throw new AnalyticsQueryError(
      `${name} must be an ISO 8601 date such as 2026-10-01 (00:00 UTC), or a date and time with Z or a UTC offset such as 2026-10-01T09:30:00Z`,
    );
  const offsetMs = zone && zone !== "Z" ? (sign === "-" ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute)) * MINUTE_MS : 0;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s, Number(fraction.padEnd(3, "0"))) - offsetMs);
}

export function validateCustomTimeRange(range: CustomTimeRange): CustomTimeRange {
  const durationMs = range.end.getTime() - range.start.getTime();
  if (!Number.isFinite(durationMs)) throw new AnalyticsQueryError("start and end must be valid times");
  if (durationMs <= 0) throw new AnalyticsQueryError("start must be before end");
  if (durationMs < MIN_CUSTOM_RANGE_MS) throw new AnalyticsQueryError("A custom time range must span at least 1 minute");
  if (durationMs > MAX_CUSTOM_RANGE_MS) throw new AnalyticsQueryError("A custom time range can span at most 10 years");
  return range;
}

/**
 * The window of an analytics request: a rolling `timeRange` (default month), or
 * a custom window from `start` and `end`, given without a timeRange or with
 * timeRange "custom".
 */
export function parseAnalyticsWindow(input: {
  timeRange?: string | null;
  start?: string | null;
  end?: string | null;
}): AnalyticsWindow {
  const { timeRange, start, end } = input;
  if (timeRange !== "custom" && !start && !end) return validateTimeRange(timeRange);
  if (timeRange && timeRange !== "custom") throw new AnalyticsQueryError("Use either timeRange or start and end, not both");
  if (!start || !end) throw new AnalyticsQueryError("A custom time range requires both start and end");
  return validateCustomTimeRange({ start: parseInstant(start, "start"), end: parseInstant(end, "end") });
}
