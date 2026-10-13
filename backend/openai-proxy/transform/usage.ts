import type { TokenUsage } from "@aws-sdk/client-bedrock-runtime";
import type { OpenAIUsage } from "./types";
import { extractConverseCacheUsage } from "./cache-usage";
import type { CostBreakdown } from "../../credit-service";
import type { CreditSettlement } from "../../credit-settlement";

/** Only a completed ledger settlement can supply cost (including a known zero). */
export function settledUsage(usage: OpenAIUsage, costs: CostBreakdown, settlement: CreditSettlement): OpenAIUsage {
  return {
    ...usage,
    cost: settlement.creditsCharged,
    cost_details: {
      currency: "USD", status: "settled", calculated_cost: settlement.actualCost,
      input_cost: costs.inputCost, output_cost: costs.outputCost,
      cache_read_cost: costs.cacheReadCost, cache_write_5m_cost: costs.cacheWrite5mCost,
      cache_write_1h_cost: costs.cacheWrite1hCost, partially_charged: settlement.partiallyCharged,
    },
  };
}

/** OpenAI prompt_tokens includes all input, even when Bedrock bills it as cache reads/writes. */
export function transformUsage(usage: TokenUsage | undefined): OpenAIUsage {
  const buckets = extractConverseCacheUsage(usage);
  const cacheRead = usage?.cacheReadInputTokens ?? 0;
  // cacheDetails breaks down cacheWriteInputTokens; never add both.
  const cacheWrite = usage?.cacheWriteInputTokens
    ?? usage?.cacheDetails?.reduce((sum, detail) => sum + (detail.inputTokens ?? 0), 0)
    ?? 0;
  const input = (usage?.inputTokens ?? 0) + cacheRead + cacheWrite;
  const output = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(cacheRead > 0 || cacheWrite > 0 ? {
      prompt_tokens_details: {
        cached_tokens: cacheRead,
        cache_creation_tokens: cacheWrite,
        cache_write_tokens: cacheWrite,
        cache_write_5m_tokens: buckets.cacheWrite5mTokens,
        cache_write_1h_tokens: buckets.cacheWrite1hTokens,
      },
      // LiteLLM-compatible extensions; both are already included in prompt_tokens.
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    } : {}),
  };
}
