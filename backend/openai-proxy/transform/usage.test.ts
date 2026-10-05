import { expect, test } from "bun:test";
import { transformUsage } from "./usage";

test("counts cached input once, including both cache-write TTLs", () => {
  expect(transformUsage({
    inputTokens: 2, outputTokens: 510, totalTokens: 512,
    cacheReadInputTokens: 7683, cacheWriteInputTokens: 1412,
    cacheDetails: [{ ttl: "5m", inputTokens: 1000 }, { ttl: "1h", inputTokens: 412 }],
  })).toEqual({
    prompt_tokens: 9097, completion_tokens: 510, total_tokens: 9607,
    prompt_tokens_details: { cached_tokens: 7683, cache_creation_tokens: 1412 },
    cache_read_input_tokens: 7683, cache_creation_input_tokens: 1412,
  });
});

test("handles cold cache writes, full cache hits, and absent usage", () => {
  expect(transformUsage({ inputTokens: 2, outputTokens: 4, totalTokens: 6, cacheWriteInputTokens: 5291 }).prompt_tokens).toBe(5293);
  expect(transformUsage({ inputTokens: 0, outputTokens: 4, totalTokens: 4, cacheReadInputTokens: 5293 }).prompt_tokens).toBe(5293);
  expect(transformUsage(undefined)).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("uses TTL details only when the aggregate cache-write count is absent", () => {
  const usage = { inputTokens: 2, outputTokens: 4, totalTokens: 6, cacheDetails: [{ ttl: "1h" as const, inputTokens: 1200 }] };
  expect(transformUsage(usage).prompt_tokens).toBe(1202);
  expect(transformUsage({ ...usage, cacheWriteInputTokens: 0 }).prompt_tokens).toBe(2);
});
