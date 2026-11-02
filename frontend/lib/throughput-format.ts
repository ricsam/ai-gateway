/** Throughput value: whole numbers from 100 up, a few decimals below so small rates stay readable. */
export function formatThroughput(value: number, locale?: string): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const options: Intl.NumberFormatOptions = value >= 100 ? { maximumFractionDigits: 0 }
    : value >= 10 ? { maximumFractionDigits: 1 }
    : { maximumSignificantDigits: 3 };
  return new Intl.NumberFormat(locale, options).format(value);
}

/** Start of a peak minute in the viewer's time zone, or null when there was no peak. */
export function formatPeakMinute(value: string | null, locale?: string, timeZone?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone });
}

export function formatActiveHours(hours: number, locale?: string): string {
  if (!hours) return "No requests in this range";
  return `Average over ${new Intl.NumberFormat(locale).format(hours)} active ${hours === 1 ? "hour" : "hours"}`;
}
