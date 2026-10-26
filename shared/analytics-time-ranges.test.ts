import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { getTimeRangeBounds, TIME_RANGES, type TimeRange } from "./analytics-time-ranges";

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
