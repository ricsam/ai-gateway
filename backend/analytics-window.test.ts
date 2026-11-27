import { describe, expect, test } from "bun:test";
import { bucketFloor, wholeBucketEnd, wholeBucketStart, type AggregateTable } from "./analytics-window";

const MINUTE = 60 * 1000;
const widths: [AggregateTable, number][] = [
  ["credit_events_5m", 5 * MINUTE],
  ["credit_events_1h", 60 * MINUTE],
  ["credit_events_1d", 24 * 60 * MINUTE],
];

describe("wholeBucketStart", () => {
  test.each([
    // "Last 7 days" requested at 2026-10-27T11:14:55.251Z starts mid-day; 20 Oct is a partial bucket.
    ["credit_events_1d", "2026-10-20T11:14:55.251Z", "2026-10-27T11:14:55.251Z", "2026-10-21T00:00:00.000Z"],
    ["credit_events_1h", "2026-10-26T11:14:55.251Z", "2026-10-27T11:14:55.251Z", "2026-10-26T12:00:00.000Z"],
    ["credit_events_5m", "2026-10-27T10:14:55.251Z", "2026-10-27T11:14:55.251Z", "2026-10-27T10:15:00.000Z"],
    // Stockholm and New York DST transitions do not move UTC buckets.
    ["credit_events_1d", "2026-10-25T01:30:00.000Z", "2026-11-01T01:30:00.000Z", "2026-10-26T00:00:00.000Z"],
    ["credit_events_1h", "2026-03-08T07:30:00.000Z", "2026-03-09T07:30:00.000Z", "2026-03-08T08:00:00.000Z"],
  ] as const)("%s window %s to %s reads whole buckets from %s", (source, start, end, expected) => {
    expect(wholeBucketStart(source, new Date(start), new Date(end)).toISOString()).toBe(expected);
  });

  test.each(widths)("keeps an aligned %s start", (source) => {
    const start = new Date("2026-10-21T00:00:00.000Z");
    expect(wholeBucketStart(source, start, new Date("2026-10-28T00:00:00.000Z")).toISOString()).toBe(start.toISOString());
  });

  test.each(widths)("never passes the end of a short %s window", (source) => {
    const end = new Date("2026-10-27T11:14:59.000Z");
    expect(wholeBucketStart(source, new Date("2026-10-27T11:14:55.251Z"), end).toISOString()).toBe(end.toISOString());
  });

  test.each(widths)("%s buckets agree with time_bucket's default origin", (source, width) => {
    // time_bucket buckets these widths from 2000-01-03 00:00 UTC; the helper aligns to the Unix epoch.
    expect(Date.UTC(2000, 0, 3) % width).toBe(0);
    const start = new Date("2026-10-20T11:14:55.251Z");
    const aligned = wholeBucketStart(source, start, new Date("2026-10-27T11:14:55.251Z")).getTime();
    expect((aligned - Date.UTC(2000, 0, 3)) % width).toBe(0);
    expect(aligned).toBeGreaterThan(start.getTime());
    expect(aligned - start.getTime()).toBeLessThan(width);
  });
});

describe("wholeBucketEnd", () => {
  test.each([
    // A custom window ending 15 Oct 12:00 reads 15 Oct 00:00-12:00 from the raw ledger, not the whole day.
    ["credit_events_1d", "2026-10-01T00:00:00.000Z", "2026-10-15T12:00:00.000Z", "2026-10-15T00:00:00.000Z"],
    ["credit_events_1h", "2026-10-01T00:00:00.000Z", "2026-10-15T12:30:00.000Z", "2026-10-15T12:00:00.000Z"],
    ["credit_events_5m", "2026-10-15T09:00:00.000Z", "2026-10-15T12:34:56.789Z", "2026-10-15T12:30:00.000Z"],
    // A rolling window ending now: its current bucket comes from the raw ledger too.
    ["credit_events_1d", "2026-10-20T11:14:55.251Z", "2026-10-27T11:14:55.251Z", "2026-10-27T00:00:00.000Z"],
  ] as const)("%s window %s to %s reads whole buckets until %s", (source, start, end, expected) => {
    expect(wholeBucketEnd(source, new Date(start), new Date(end)).toISOString()).toBe(expected);
  });

  test.each(widths)("keeps an aligned %s end", (source) => {
    const end = new Date("2026-10-28T00:00:00.000Z");
    expect(wholeBucketEnd(source, new Date("2026-10-21T00:00:00.000Z"), end).toISOString()).toBe(end.toISOString());
  });

  test.each(widths)("never precedes the whole buckets' start in a short %s window", (source) => {
    // Both ends inside one bucket: everything comes from the raw ledger.
    const start = new Date("2026-10-27T11:14:55.251Z");
    const end = new Date("2026-10-27T11:14:59.000Z");
    expect(wholeBucketStart(source, start, end).toISOString()).toBe(end.toISOString());
    expect(wholeBucketEnd(source, start, end).toISOString()).toBe(end.toISOString());
  });

  test.each(widths)("splits a %s window into raw, aggregate and raw parts that cover it once", (source, width) => {
    for (const [start, end] of [
      ["2026-10-20T11:14:55.251Z", "2026-10-27T11:14:55.251Z"],
      ["2026-10-01T00:00:00.000Z", "2026-10-01T00:07:30.000Z"],
      ["2026-10-01T23:59:00.000Z", "2026-10-02T00:01:00.000Z"],
    ].map(([from, to]) => [new Date(from!), new Date(to!)] as const)) {
      const first = wholeBucketStart(source, start, end).getTime();
      const last = wholeBucketEnd(source, start, end).getTime();
      expect(start.getTime()).toBeLessThanOrEqual(first);
      expect(first).toBeLessThanOrEqual(last);
      expect(last).toBeLessThanOrEqual(end.getTime());
      expect((last - first) % width).toBe(0);
      expect(first - start.getTime()).toBeLessThan(width);
      expect(end.getTime() - last).toBeLessThan(width);
    }
  });
});

describe("bucketFloor", () => {
  test.each(widths)("finds the %s bucket that holds a time", (source, width) => {
    const time = new Date("2026-10-27T11:14:55.251Z");
    const floor = bucketFloor(source, time).getTime();
    expect(floor).toBeLessThanOrEqual(time.getTime());
    expect(time.getTime() - floor).toBeLessThan(width);
    expect((floor - Date.UTC(2000, 0, 3)) % width).toBe(0);
    expect(bucketFloor(source, new Date(floor)).getTime()).toBe(floor);
  });
});
