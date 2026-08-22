import { describe, expect, test } from "bun:test";
import {
  METERED_USAGE_EVENT_TYPES,
  UsageValidationError,
  buildLiteLLMDailyActivity,
  buildNativeMonthlyUsage,
  currentUtcMonthRange,
  isMeteredUsageEventType,
  parseUtcDailyRange,
} from "./usage-contract";

describe("usage date ranges", () => {
  test("uses exact UTC calendar-month boundaries", () => {
    const range = currentUtcMonthRange(new Date("2024-02-29T23:59:59.999Z"));
    expect(range.start.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(range.startDate).toBe("2024-02-01");
    expect(range.endDate).toBe("2024-02-29");
  });

  test("parses inclusive daily dates into an exclusive SQL boundary", () => {
    const range = parseUtcDailyRange("2025-03-20", "2025-03-27");
    expect(range.start.toISOString()).toBe("2025-03-20T00:00:00.000Z");
    expect(range.endExclusive.toISOString()).toBe("2025-03-28T00:00:00.000Z");
  });

  test("allows 366 inclusive days and rejects a longer range", () => {
    expect(parseUtcDailyRange("2024-01-01", "2024-12-31").endDate).toBe("2024-12-31");
    expect(() => parseUtcDailyRange("2024-01-01", "2025-01-01")).toThrow("366");
  });

  test("rejects missing, impossible, and reversed dates with stable params", () => {
    expect(() => parseUtcDailyRange(null, "2025-01-01")).toThrow("start_date is required");
    expect(() => parseUtcDailyRange("2025-02-29", "2025-03-01")).toThrow("valid date");
    try {
      parseUtcDailyRange("2025-03-02", "2025-03-01");
      throw new Error("Expected validation error");
    } catch (error) {
      expect(error).toBeInstanceOf(UsageValidationError);
      expect((error as UsageValidationError).param).toBe("end_date");
    }
  });
});

describe("metered usage classification", () => {
  test("includes inference history and excludes balance adjustments", () => {
    expect(METERED_USAGE_EVENT_TYPES).toEqual(["usage", "chat", "api", "embedding"]);
    for (const type of METERED_USAGE_EVENT_TYPES) expect(isMeteredUsageEventType(type)).toBe(true);
    expect(isMeteredUsageEventType("monthly_reset")).toBe(false);
    expect(isMeteredUsageEventType("admin_adjustment")).toBe(false);
    const events = [
      { type: "usage", spend: 1.25 },
      { type: "chat", spend: 0.5 },
      { type: "monthly_reset", spend: 30 },
      { type: "admin_adjustment", spend: 7 },
    ];
    expect(events.filter((event) => isMeteredUsageEventType(event.type)).reduce((sum, event) => sum + event.spend, 0)).toBe(1.75);
  });
});

describe("native monthly summary", () => {
  const range = currentUtcMonthRange(new Date("2025-04-15T12:00:00Z"));

  test("reports spend percentage, requests, and detailed cache token totals", () => {
    const summary = buildNativeMonthlyUsage({
      range,
      balance: 7.5,
      monthlyAllocation: 10,
      metrics: {
        spend: 2.5,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWrite5mTokens: 7,
        cacheWrite1hTokens: 3,
        requests: 4,
      },
    });
    expect(summary.credits).toEqual({ used: 2.5, balance: 7.5, monthly_allocation: 10, percent_used: 25 });
    expect(summary.requests).toBe(4);
    expect(summary.tokens).toEqual({
      input: 100,
      output: 40,
      cache_read: 20,
      cache_write_5m: 7,
      cache_write_1h: 3,
      cache_write: 10,
      total: 170,
    });
  });

  test("returns null percentage for an unmetered allocation", () => {
    const summary = buildNativeMonthlyUsage({
      range,
      balance: 0,
      monthlyAllocation: 0,
      metrics: { spend: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requests: 1 },
    });
    expect(summary.credits.percent_used).toBeNull();
  });
});

describe("LiteLLM daily activity mapping", () => {
  test("returns stable empty totals", () => {
    expect(buildLiteLLMDailyActivity([])).toEqual({
      results: [],
      metadata: {
        total_spend: 0,
        total_prompt_tokens: 0,
        total_completion_tokens: 0,
        total_tokens: 0,
        total_api_requests: 0,
        total_cache_read_input_tokens: 0,
        total_cache_creation_input_tokens: 0,
        page: 1,
        total_pages: 1,
        has_more: false,
      },
    });
  });

  test("keeps daily totals consistent with model, provider, and opaque key breakdowns", () => {
    const activity = buildLiteLLMDailyActivity([
      {
        date: "2025-03-27", model: "model-a", apiKeyId: "key-1", spend: 1.25,
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWrite5mTokens: 4, cacheWrite1hTokens: 6, requests: 2,
      },
      {
        date: "2025-03-27", model: "model-b", apiKeyId: null, spend: 0.75,
        inputTokens: 50, outputTokens: 30, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requests: 1,
      },
      {
        date: "2025-03-26", model: "model-a", apiKeyId: "key-1", spend: 0.5,
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, requests: 1,
      },
    ]);

    expect(activity.results.map((result) => result.date)).toEqual(["2025-03-27", "2025-03-26"]);
    expect(activity.results[0]!.metrics).toEqual({
      spend: 2,
      prompt_tokens: 150,
      completion_tokens: 50,
      total_tokens: 200,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 10,
      api_requests: 3,
    });
    expect(activity.results[0]!.breakdown.models["model-a"]!.metrics.spend).toBe(1.25);
    expect(activity.results[0]!.breakdown.providers.bedrock!.metrics).toEqual(activity.results[0]!.metrics);
    expect(activity.results[0]!.breakdown.api_keys["key-1"]!.metrics.spend).toBe(1.25);
    expect(activity.results[0]!.breakdown.api_keys.playground!.metadata.key_alias).toBe("playground");
    expect(activity.metadata).toMatchObject({
      total_spend: 2.5,
      total_prompt_tokens: 160,
      total_completion_tokens: 55,
      total_tokens: 215,
      total_api_requests: 4,
      total_cache_read_input_tokens: 10,
      total_cache_creation_input_tokens: 10,
    });
  });
});
