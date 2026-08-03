/**
 * Utility helpers for OpenAI proxy transformations
 */

/**
 * Generate an OpenAI-style completion ID
 * Format: "chatcmpl-<uuid>"
 */
export function generateChatCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

/**
 * Get the current Unix timestamp (seconds since epoch)
 */
export function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/** OpenAI finish_reason values */
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";

/**
 * Map Bedrock stopReason to OpenAI finish_reason
 * 
 * Bedrock stopReason values:
 * - end_turn: Normal completion
 * - stop_sequence: Hit a stop sequence
 * - max_tokens: Reached token limit
 * - tool_use: Model wants to use a tool
 * - content_filtered: Content was filtered
 * - guardrail_intervened: Guardrail blocked content
 * 
 * OpenAI finish_reason values:
 * - stop: Normal stop or stop sequence
 * - length: Max tokens reached
 * - tool_calls: Model wants to call tools
 * - content_filter: Content was filtered
 */
export function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filtered":
      return "content_filter";
    case "guardrail_intervened":
      return "content_filter";
    default:
      // Default to "stop" for unknown or undefined reasons
      return "stop";
  }
}
