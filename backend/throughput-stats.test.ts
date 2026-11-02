import { describe, expect, test } from "bun:test";
import { getTimeRangeBounds, TIME_RANGES, type TimeRange } from "../shared/analytics-time-ranges";
import { emptyThroughputStats, throughputPeriodCount, throughputStats, type ThroughputAggregate } from "./throughput-stats";

const aggregate = (values: Partial<ThroughputAggregate> = {}): ThroughputAggregate => ({
  requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, activeHours: 0,
  peakRequests: 0, peakRequestsAt: null, peakTokens: 0, peakTokensAt: null, ...values,
});

describe("throughput windows", () => {
  test.each(Object.keys(TIME_RANGES) as TimeRange[])("%s consists of whole one-hour periods", (range) => {
    const { start, end } = getTimeRangeBounds(range, new Date("2026-10-25T01:30:12.345Z"));
    expect(throughputPeriodCount(start, end)).toBe(TIME_RANGES[range].durationMs / 3_600_000);
  });

  test("rejects windows that would leave a partial or no period", () => {
    const start = new Date("2026-11-02T10:00:00.000Z");
    expect(() => throughputPeriodCount(start, new Date("2026-11-02T10:30:00.000Z"))).toThrow("whole number of hours");
    expect(() => throughputPeriodCount(start, new Date("2026-11-02T11:00:00.001Z"))).toThrow("whole number of hours");
    expect(() => throughputPeriodCount(start, start)).toThrow("whole number of hours");
    expect(() => throughputPeriodCount(start, new Date("2026-11-02T09:00:00.000Z"))).toThrow("whole number of hours");
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
