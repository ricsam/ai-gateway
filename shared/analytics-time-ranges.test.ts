import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_BUCKETS,
  AnalyticsQueryError,
  BUCKET_SIZES,
  getBucketOptions,
  getTimeRangeBounds,
  getWindowBounds,
  MAX_CUSTOM_BUCKETS,
  parseAnalyticsWindow,
  parseInstant,
  TIME_RANGES,
  validateBucketSize,
  validateTimeRange,
  type BucketSize,
  type CustomTimeRange,
  type TimeRange,
} from "./analytics-time-ranges";

const ranges: [TimeRange, string, number][] = [
  ["hour", "Last 60 minutes", 1],
  ["day", "Last 24 hours", 24],
  ["week", "Last 7 days", 7 * 24],
  ["month", "Last 30 days", 30 * 24],
  ["quarter", "Last 90 days", 90 * 24],
  ["year", "Last 365 days", 365 * 24],
];
const anchors = [
  "2026-10-13T13:57:22.951Z", // Mid-period: preserve time of day and milliseconds.
  "2026-03-31T23:59:59.999Z", // Month-end overflow with calendar subtraction.
  "2026-05-31T12:00:00.000Z", // Quarter subtraction would overflow February.
  "2024-02-29T12:00:00.000Z", // Leap day.
  "2025-02-28T12:00:00.000Z", // A trailing calendar year would span 366 days.
  "2026-01-01T00:00:00.000Z", // Year boundary.
  "2026-03-08T07:30:00.000Z", // New York spring DST transition.
  "2026-11-01T06:30:00.000Z", // New York repeated hour at fall DST transition.
  "2026-03-29T01:30:00.000Z", // Stockholm spring DST transition.
  "2026-10-25T01:30:00.000Z", // Stockholm repeated hour at fall DST transition.
];

describe("analytics rolling time ranges", () => {
  test("preserves the existing API and preference values and display order", () => {
    expect(Object.keys(TIME_RANGES)).toEqual(ranges.map(([value]) => value));
  });

  test.each(ranges)("%s label matches its fixed elapsed duration", (range, label, hours) => {
    expect(TIME_RANGES[range].label).toBe(label);
    for (const anchor of anchors) {
      const now = new Date(anchor);
      const { start, end } = getTimeRangeBounds(range, now);
      expect(end.getTime() - start.getTime()).toBe(hours * 60 * 60 * 1000);
      expect(end.toISOString()).toBe(anchor);
      expect(now.toISOString()).toBe(anchor);
      expect(start).not.toBe(now);
      expect(end).not.toBe(now);
      expect(start).not.toBe(end);
    }
  });

  test.each([
    ["month", "2026-03-31T12:00:00.000Z", "2026-03-01T12:00:00.000Z"],
    ["quarter", "2026-05-31T12:00:00.000Z", "2026-03-02T12:00:00.000Z"],
    ["year", "2024-02-29T12:00:00.000Z", "2023-03-01T12:00:00.000Z"],
    ["year", "2025-02-28T12:00:00.000Z", "2024-02-29T12:00:00.000Z"],
  ] as const)("%s at %s starts at %s, not a calendar boundary", (range, anchor, expected) => {
    expect(getTimeRangeBounds(range, new Date(anchor)).start.toISOString()).toBe(expected);
  });

  // Test in separate processes so changing TZ cannot affect other concurrent tests.
  test.each(["UTC", "America/New_York", "Europe/Stockholm"])("elapsed windows are independent of DST in %s", (timezone) => {
    const modulePath = fileURLToPath(new URL("./analytics-time-ranges.ts", import.meta.url));
    const script = `
      import { getTimeRangeBounds } from ${JSON.stringify(modulePath)};
      const values = ${JSON.stringify(ranges)}.flatMap(([range]) =>
        ${JSON.stringify(anchors)}.map((anchor) => {
          const { start, end } = getTimeRangeBounds(range, new Date(anchor));
          return end.getTime() - start.getTime();
        })
      );
      console.log(JSON.stringify(values));
    `;
    const result = Bun.spawnSync([process.execPath, "--eval", script], {
      env: { TZ: timezone },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(
      ranges.flatMap(([, , hours]) => anchors.map(() => hours * 60 * 60 * 1000)),
    );
  });
});

const custom = (start: string, end: string): CustomTimeRange => ({ start: new Date(start), end: new Date(end) });
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("analytics windows", () => {
  test("keeps the rolling presets' values, defaults and validation", () => {
    expect(validateTimeRange(undefined)).toBe("month");
    expect(validateTimeRange("week")).toBe("week");
    // Inherited object properties are not time ranges.
    for (const value of ["custom", "constructor", "toString", "Week"]) expect(() => validateTimeRange(value)).toThrow(AnalyticsQueryError);
    for (const range of Object.keys(TIME_RANGES) as TimeRange[]) expect(getBucketOptions(range)).toBe(ALLOWED_BUCKETS[range]);
    expect(validateBucketSize("week")).toBe("1d");
    expect(() => validateBucketSize("week", "1h")).toThrow('Invalid bucket size "1h" for time range "week". Allowed: 1d');
  });

  test("reads a rolling window or a custom window's own bounds", () => {
    const now = new Date("2026-10-29T13:55:00.000Z");
    expect(getWindowBounds("week", now)).toEqual(getTimeRangeBounds("week", now));
    const window = custom("2026-10-01T00:00:00.000Z", "2026-10-15T12:00:00.000Z");
    const bounds = getWindowBounds(window, now);
    expect(bounds).toEqual({ start: window.start, end: window.end });
    expect(bounds.start).not.toBe(window.start);
  });

  test("parses custom windows from start and end", () => {
    expect(parseAnalyticsWindow({ timeRange: "day" })).toBe("day");
    expect(parseAnalyticsWindow({})).toBe("month");
    const expected = custom("2026-10-01T07:30:00.000Z", "2026-10-15T00:00:00.000Z");
    expect(parseAnalyticsWindow({ start: "2026-10-01T09:30:00+02:00", end: "2026-10-15" })).toEqual(expected);
    expect(parseAnalyticsWindow({ timeRange: "custom", start: "2026-10-01T07:30Z", end: "2026-10-15T00:00:00.000Z" })).toEqual(expected);
    // An unencoded "+" offset arrives in a query string as a space.
    expect(parseAnalyticsWindow({ start: "2026-10-01T09:30:00 02:00", end: "2026-10-15" })).toEqual(expected);
  });

  test.each([
    [{ timeRange: "week", start: "2026-10-01", end: "2026-10-02" }, "either timeRange or start and end"],
    [{ timeRange: "custom" }, "requires both start and end"],
    [{ start: "2026-10-01" }, "requires both start and end"],
    [{ end: "2026-10-01" }, "requires both start and end"],
    [{ start: "2026-10-02", end: "2026-10-01" }, "start must be before end"],
    [{ start: "2026-10-01", end: "2026-10-01" }, "start must be before end"],
    [{ start: "2026-10-01T00:00:00Z", end: "2026-10-01T00:00:59Z" }, "at least 1 minute"],
    [{ start: "2016-01-01", end: "2026-10-02" }, "at most 10 years"],
    [{ start: "2026-10-01T09:30", end: "2026-10-02" }, "start must be an ISO 8601 date"],
    [{ start: "2026-10-01", end: "yesterday" }, "end must be an ISO 8601 date"],
  ])("refuses %j", (input, message) => {
    expect(() => parseAnalyticsWindow(input)).toThrow(AnalyticsQueryError);
    expect(() => parseAnalyticsWindow(input)).toThrow(message);
  });

  test("parses instants field by field, independently of the server's time zone", () => {
    expect(parseInstant("2026-10-01").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(parseInstant("2026-10-01T23:59:59.5-05:30").toISOString()).toBe("2026-10-02T05:29:59.500Z");
    expect(parseInstant("2024-02-29T12:00Z").toISOString()).toBe("2024-02-29T12:00:00.000Z");
    for (const value of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-10-01T24:00Z", "2026-10-01T09:60Z", "1969-12-31", "2026-10-01T09:30:00.1234Z", "2026-10-01 09:30Z"])
      expect(() => parseInstant(value, "start")).toThrow("start must be an ISO 8601 date");
  });
});

describe("custom window intervals", () => {
  const buckets = (window: CustomTimeRange, size: BucketSize) =>
    Math.ceil((window.end.getTime() - window.start.getTime()) / BUCKET_SIZES[size].durationMs);
  const lasting = (durationMs: number) => ({ start: new Date("2026-10-01T00:00:00.000Z"), end: new Date(Date.parse("2026-10-01T00:00:00.000Z") + durationMs) });

  test.each(Object.keys(TIME_RANGES) as TimeRange[])("a custom window as long as %s defaults to that preset's interval", (range) => {
    const options = getBucketOptions(lasting(TIME_RANGES[range].durationMs));
    expect(options.default).toBe(ALLOWED_BUCKETS[range].default);
    for (const size of ALLOWED_BUCKETS[range].allowed) expect(options.allowed).toContain(size);
  });

  test.each([
    [MINUTE, ["15s", "1m"], "15s"],
    [2 * HOUR, ["1m", "5m", "30m", "1h"], "5m"],
    [2 * DAY, ["30m", "1h", "1d"], "1h"],
    [25 * HOUR, ["5m", "30m", "1h", "1d"], "1h"],
    [5 * DAY, ["30m", "1h", "1d"], "1d"],
    [365 * DAY, ["1d", "1w", "1mo"], "1mo"],
    [2 * 365 * DAY, ["1w", "1mo"], "1mo"],
    [3653 * DAY, ["1mo"], "1mo"],
  ] as const)("a window of %d ms allows %j and defaults to %s", (durationMs, allowed, preferred) => {
    expect(getBucketOptions(lasting(durationMs))).toEqual({ allowed: [...allowed], default: preferred });
  });

  test("never allows an interval longer than the window or one giving too many buckets", () => {
    for (let durationMs = MINUTE; durationMs <= 3653 * DAY; durationMs = Math.ceil(durationMs * 1.37)) {
      const window = lasting(durationMs);
      const options = getBucketOptions(window);
      expect(options.allowed.length).toBeGreaterThan(0);
      expect(options.allowed).toContain(options.default);
      for (const size of options.allowed) {
        expect(BUCKET_SIZES[size].durationMs).toBeLessThanOrEqual(durationMs);
        expect(buckets(window, size)).toBeLessThanOrEqual(MAX_CUSTOM_BUCKETS);
      }
    }
  });

  test("validates a custom window's interval", () => {
    const window = custom("2026-10-01T00:00:00.000Z", "2026-10-04T00:00:00.000Z");
    expect(validateBucketSize(window)).toBe("1h");
    expect(validateBucketSize(window, "30m")).toBe("30m");
    expect(() => validateBucketSize(window, "5m")).toThrow('Invalid bucket size "5m" for this custom time range. Allowed: 30m, 1h, 1d');
  });
});
