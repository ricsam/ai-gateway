import { BUCKET_SIZES, type BucketSize } from "../../shared/analytics-time-ranges";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What chart axes need to label a window's buckets. */
export interface TimeScale {
  durationMs: number;
  bucketSize: BucketSize;
}

/**
 * Label of a bucket's start for chart axes and tooltips: the time for windows
 * of up to a day, the date and time for longer windows with sub-day buckets,
 * and the date (with the year for windows longer than about half a year)
 * otherwise. Presets keep the labels they had.
 */
export function formatBucketTime(value: string, scale: TimeScale, locale?: string, timeZone?: string): string {
  const date = new Date(value);
  const bucketMs = BUCKET_SIZES[scale.bucketSize].durationMs;
  if (bucketMs < DAY_MS) {
    const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", ...(bucketMs < 60_000 ? { second: "2-digit" } : {}), timeZone });
    if (scale.durationMs <= DAY_MS) return time;
    return `${date.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone })}, ${time}`;
  }
  return date.toLocaleDateString(locale, { month: "short", day: "numeric", ...(scale.durationMs > 180 * DAY_MS ? { year: "2-digit" } : {}), timeZone });
}

const pad = (value: number) => String(value).padStart(2, "0");

/** A time as a datetime-local input shows it: minutes in the browser's time zone. */
export function toDateTimeLocal(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** A datetime-local input's value in the browser's time zone; null while incomplete or invalid. */
export function fromDateTimeLocal(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const date = new Date(year!, month! - 1, day!, hour!, minute!, second!);
  // Days and months past their end would roll over into the next month or year.
  return Number.isNaN(date.getTime()) || date.getDate() !== day || date.getMonth() !== month! - 1 ? null : date;
}

/** A custom window for people, such as "Oct 1, 2026, 09:00 – Oct 15, 2026, 17:00", in the browser's time zone. */
export function formatWindow(start: Date, end: Date, locale?: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone };
  return `${start.toLocaleString(locale, options)} – ${end.toLocaleString(locale, options)}`;
}
