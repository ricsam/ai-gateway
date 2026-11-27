import { describe, expect, test } from "bun:test";
import { getTimeRangeBounds, TIME_RANGES, type TimeRange } from "../shared/analytics-time-ranges";
import { activePeriodHours, emptyThroughputStats, throughputPeriods, throughputStats, type ThroughputAggregate } from "./throughput-stats";

const aggregate = (values: Partial<ThroughputAggregate> = {}): ThroughputAggregate => ({
  requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, activeHours: 0,
  peakRequests: 0, peakRequestsAt: null, peakTokens: 0, peakTokensAt: null, ...values,
});

describe("throughput windows", () => {
  test.each(Object.keys(TIME_RANGES) as TimeRange[])("%s consists of whole one-hour periods", (range) => {
    const { start, end } = getTimeRangeBounds(range, new Date("2026-10-25T01:30:12.345Z"));
    const periods = throughputPeriods(start, end);
    expect(periods.count).toBe(TIME_RANGES[range].durationMs / 3_600_000);
    expect(periods.lastPeriodHours).toBe(1);
    expect(periods.lastPeriodStart.getTime()).toBe(end.getTime() - 3_600_000);
  });

  test("ends a custom window that is not a whole number of hours with a shorter period", () => {
    const start = new Date("2026-11-02T10:00:00.000Z");
    expect(throughputPeriods(start, new Date("2026-11-02T10:30:00.000Z"))).toEqual({ count: 1, lastPeriodStart: start, lastPeriodHours: 0.5 });
    expect(throughputPeriods(start, new Date("2026-11-02T12:45:00.000Z"))).toEqual({
      count: 3, lastPeriodStart: new Date("2026-11-02T12:00:00.000Z"), lastPeriodHours: 0.75,
    });
  });

  test("rejects empty and reversed windows", () => {
    const start = new Date("2026-11-02T10:00:00.000Z");
    expect(() => throughputPeriods(start, start)).toThrow("end after they start");
    expect(() => throughputPeriods(start, new Date("2026-11-02T09:00:00.000Z"))).toThrow("end after they start");
  });

  test("counts a shorter last period by its length only when it had requests", () => {
    const periods = throughputPeriods(new Date("2026-11-02T10:00:00.000Z"), new Date("2026-11-02T12:45:00.000Z"));
    // Periods start at 10:00, 11:00 and 12:00; the last one lasts 45 minutes.
    expect(activePeriodHours("3", new Date("2026-11-02T12:00:00.000Z"), periods)).toBe(2.75);
    expect(activePeriodHours("1", "2026-11-02T12:00:00.000Z", periods)).toBe(0.75);
    expect(activePeriodHours(2, new Date("2026-11-02T11:00:00.000Z"), periods)).toBe(2);
    expect(activePeriodHours(0, null, periods)).toBe(0);
    // Whole-hour windows count whole periods.
    const whole = throughputPeriods(new Date("2026-11-02T10:00:00.000Z"), new Date("2026-11-02T13:00:00.000Z"));
    expect(activePeriodHours("3", new Date("2026-11-02T12:00:00.000Z"), whole)).toBe(3);
  });

  test("steady state over a shorter last period divides by its minutes", () => {
    const periods = throughputPeriods(new Date("2026-11-02T10:00:00.000Z"), new Date("2026-11-02T10:30:00.000Z"));
    const stats = throughputStats(aggregate({ requests: 15, inputTokens: 3_000, activeHours: activePeriodHours(1, "2026-11-02T10:00:00.000Z", periods) }));
    expect(stats.activeHours).toBe(0.5);
    expect(stats.steadyStateRpm).toBe(0.5);
    expect(stats.steadyStateTpm).toBe(100);
  });
});

describe("throughput statistics", () => {
  test("derives steady state from active hours, peaks from the busiest minute and per-request averages", () => {
    const stats = throughputStats(aggregate({
      // PostgreSQL returns bigint and numeric aggregates as strings.
      requests: "40", inputTokens: "90000", outputTokens: "30000", cacheReadTokens: "400000", activeHours: "2",
      peakRequests: "9", peakRequestsAt: new Date("2026-11-02T09:41:00Z"),
      peakTokens: "21000", peakTokensAt: "2026-11-02 09:42:00+00",
    }));
    expect(stats).toEqual({
      requests: 40,
      tokens: 120_000,
      activeHours: 2,
      steadyStateTpm: 1_000,
      steadyStateRpm: 40 / 120,
      peakTpm: 21_000,
      peakTpmAt: "2026-11-02T09:42:00.000Z",
      peakRpm: 9,
      peakRpmAt: "2026-11-02T09:41:00.000Z",
      avgInputTokensPerRequest: 2_250,
      avgOutputTokensPerRequest: 750,
      avgCacheReadTokensPerRequest: 10_000,
    });
  });

  test("steady TPM equals steady RPM times the average input plus output tokens", () => {
    const stats = throughputStats(aggregate({ requests: 7, inputTokens: 12_345, outputTokens: 678, activeHours: 3, peakRequests: 2, peakTokens: 4_000 }));
    expect(stats.steadyStateTpm).toBeCloseTo(stats.steadyStateRpm * (stats.avgInputTokensPerRequest + stats.avgOutputTokensPerRequest), 9);
    expect(stats.steadyStateTpm).toBeCloseTo(13_023 / 180, 9);
  });

  test("no traffic reports zeros without peak times instead of dividing by zero", () => {
    expect(throughputStats(aggregate())).toEqual(emptyThroughputStats());
    expect(throughputStats(aggregate({ requests: null, inputTokens: undefined, activeHours: "", peakRequestsAt: "2026-11-02T09:41:00Z" }))).toEqual(emptyThroughputStats());
  });

  test("zero-token requests still count toward request rates but report no token peak time", () => {
    const stats = throughputStats(aggregate({ requests: 3, activeHours: 1, peakRequests: 2, peakRequestsAt: "2026-11-02T09:41:00Z", peakTokensAt: "2026-11-02T09:41:00Z" }));
    expect(stats).toMatchObject({ requests: 3, tokens: 0, steadyStateRpm: 0.05, steadyStateTpm: 0, peakRpm: 2, peakRpmAt: "2026-11-02T09:41:00.000Z", peakTpm: 0, peakTpmAt: null, avgInputTokensPerRequest: 0 });
  });

  test("ignores invalid and negative values", () => {
    expect(throughputStats(aggregate({ requests: "NaN", inputTokens: -5, outputTokens: Infinity, activeHours: -1, peakRequests: 1, peakRequestsAt: "not a date" }))).toEqual({ ...emptyThroughputStats(), peakRpm: 1 });
  });
});
