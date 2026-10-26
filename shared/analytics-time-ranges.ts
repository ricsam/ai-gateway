// Keep these values stable: they are API parameters and saved browser preferences.
export type TimeRange = "hour" | "day" | "week" | "month" | "quarter" | "year";

const HOUR_MS = 60 * 60 * 1000;
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

export function getTimeRangeBounds(timeRange: TimeRange, now = new Date()): { start: Date; end: Date } {
  const end = new Date(now);
  // Timestamp arithmetic avoids calendar overflow, leap-year and DST changes.
  const start = new Date(end.getTime() - TIME_RANGES[timeRange].durationMs);
  return { start, end };
}
