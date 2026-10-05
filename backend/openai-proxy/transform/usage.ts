import type { TokenUsage } from "@aws-sdk/client-bedrock-runtime";
import type { OpenAIUsage } from "./types";

/** OpenAI prompt_tokens includes all input, even when Bedrock bills it as cache reads/writes. */
export function transformUsage(usage: TokenUsage | undefined): OpenAIUsage {
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
      },
      // LiteLLM-compatible extensions; both are already included in prompt_tokens.
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    } : {}),
  };
}
