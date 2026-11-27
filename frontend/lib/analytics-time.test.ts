import { describe, expect, test } from "bun:test";
import { TIME_RANGES, ALLOWED_BUCKETS, type TimeRange } from "../../shared/analytics-time-ranges";
import { formatBucketTime, formatWindow, fromDateTimeLocal, toDateTimeLocal } from "./analytics-time";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = "2026-10-05T09:30:00.000Z";
const label = (durationMs: number, bucketSize: Parameters<typeof formatBucketTime>[1]["bucketSize"]) =>
  formatBucketTime(at, { durationMs, bucketSize }, "en-US", "UTC");

describe("chart time labels", () => {
  test("keep the presets' labels: times up to a day, dates beyond, with the year for a year", () => {
    const presets = Object.fromEntries((Object.keys(TIME_RANGES) as TimeRange[]).map((range) => [range, label(TIME_RANGES[range].durationMs, ALLOWED_BUCKETS[range].default)]));
    expect(presets).toEqual({ hour: "09:30 AM", day: "09:30 AM", week: "Oct 5", month: "Oct 5", quarter: "Oct 5", year: "Oct 5, 26" });
  });

  test("show the date with the time for longer windows with sub-day buckets, and seconds for 15-second buckets", () => {
    expect(label(3 * DAY, "1h")).toBe("Oct 5, 09:30 AM");
    expect(label(HOUR, "15s")).toBe("09:30:00 AM");
    expect(label(2 * 365 * DAY, "1mo")).toBe("Oct 5, 26");
  });

  test("describe a custom window", () => {
    expect(formatWindow(new Date("2026-10-01T09:00:00Z"), new Date("2026-10-15T17:00:00Z"), "en-US", "UTC")).toBe("Oct 1, 2026, 09:00 AM – Oct 15, 2026, 05:00 PM");
  });
});

describe("datetime-local values", () => {
  test("round-trip times to the minute in the browser's time zone", () => {
    for (const value of ["2026-10-05T09:30:00.000Z", "2026-03-29T00:59:00.000Z", "2024-02-29T23:00:00.000Z", "2026-12-31T23:59:59.999Z"]) {
      const date = new Date(value);
      const minute = new Date(Math.floor(date.getTime() / 60_000) * 60_000);
      expect(toDateTimeLocal(date)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(fromDateTimeLocal(toDateTimeLocal(date))?.toISOString()).toBe(minute.toISOString());
    }
  });

  test("read seconds, and refuse incomplete and impossible values", () => {
    expect(fromDateTimeLocal("2026-10-05T09:30:15")?.getSeconds()).toBe(15);
    for (const value of ["", "2026-10-05", "2026-10-05T9:30", "2026-02-30T10:00", "2026-13-01T10:00"]) expect(fromDateTimeLocal(value)).toBeNull();
  });
});
