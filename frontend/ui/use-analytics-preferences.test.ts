import { describe, expect, test } from "bun:test";
import { parsePreferences, preferenceWindow } from "./use-analytics-preferences";

describe("saved analytics preferences", () => {
  test("keep valid rolling ranges and intervals", () => {
    expect(parsePreferences({ timeRange: "day", bucketSize: "30m" })).toEqual({ timeRange: "day", bucketSize: "30m" });
    expect(parsePreferences({ timeRange: "week", bucketSize: "30m" })).toEqual({ timeRange: "week", bucketSize: "1d" });
  });

  test("fall back to the defaults for anything else", () => {
    for (const saved of [null, "month", [], { timeRange: "decade" }, { timeRange: "constructor" }, { timeRange: "custom" }])
      expect(parsePreferences(saved)).toEqual({ timeRange: "month", bucketSize: "1d" });
  });

  test("keep a valid custom window with an interval it allows", () => {
    const custom = { start: "2026-10-01T00:00:00.000Z", end: "2026-10-04T00:00:00.000Z" };
    expect(parsePreferences({ timeRange: "custom", custom, bucketSize: "30m" })).toEqual({ timeRange: "custom", custom, bucketSize: "30m" });
    // 5-minute buckets would be too many for three days: the window's default instead.
    expect(parsePreferences({ timeRange: "custom", custom, bucketSize: "5m" })).toEqual({ timeRange: "custom", custom, bucketSize: "1h" });
    expect(preferenceWindow({ timeRange: "custom", custom })).toEqual({ start: new Date(custom.start), end: new Date(custom.end) });
  });

  test("drop custom windows that are no longer valid", () => {
    for (const custom of [{ start: "2026-10-04T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" }, { start: "soon", end: "later" }, { start: 1, end: 2 }])
      expect(parsePreferences({ timeRange: "custom", custom })).toEqual({ timeRange: "month", bucketSize: "1d" });
  });
});
