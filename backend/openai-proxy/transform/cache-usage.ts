/**
 * Extract cache usage metrics from Bedrock Converse API responses
 */
import type { TokenUsage, ConverseStreamMetadataEvent } from "@aws-sdk/client-bedrock-runtime";

/**
 * Structured cache usage metrics
 */
export interface CacheUsage {
  /** Total tokens read from cache */
  cacheReadTokens: number;
  /** Tokens written to 5-minute TTL cache */
  cacheWrite5mTokens: number;
  /** Tokens written to 1-hour TTL cache */
  cacheWrite1hTokens: number;
}

/**
 * Extract cache usage from Converse API TokenUsage
 * Works for both non-streaming response.usage and streaming event.metadata.usage
 */
export function extractConverseCacheUsage(usage: TokenUsage | undefined): CacheUsage {
  if (!usage) {
    return { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
  }

  const cacheReadTokens = usage.cacheReadInputTokens ?? 0;

  // If we have cacheDetails, use them to determine TTL-specific writes
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;

  if (usage.cacheDetails && usage.cacheDetails.length > 0) {
    for (const detail of usage.cacheDetails) {
      const tokens = detail.inputTokens ?? 0;
      if (detail.ttl === "5m") {
        cacheWrite5mTokens += tokens;
      } else if (detail.ttl === "1h") {
        cacheWrite1hTokens += tokens;
      }
    }
  } else {
    // If no cacheDetails, put all writes in the 5m bucket as a default
    // This is a fallback - in practice, cacheDetails should be present
    cacheWrite5mTokens = usage.cacheWriteInputTokens ?? 0;
  }

  return {
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
  };
}

/**
 * Extract cache usage from streaming metadata event
 */
export function extractStreamingCacheUsage(
  metadata: ConverseStreamMetadataEvent | undefined
): CacheUsage {
  return extractConverseCacheUsage(metadata?.usage);
}

/**
 * Merge cache usage from multiple sources (useful for streaming accumulation)
 */
export function mergeCacheUsage(a: CacheUsage, b: CacheUsage): CacheUsage {
  return {
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  };
}

/**
 * Create empty cache usage object
 */
export function emptyCacheUsage(): CacheUsage {
  return { cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
}

// ============================================================================
// Anthropic InvokeModel cache usage extraction
// ============================================================================

/**
 * Anthropic native format usage structure
 * This is what InvokeModel returns in the response body
 */
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Anthropic response body structure
 */
interface AnthropicResponse {
  usage?: AnthropicUsage;
  [key: string]: unknown;
}

/**
 * Extract cache usage from Anthropic InvokeModel response
 * 
 * Anthropic uses:
 * - `cache_creation_input_tokens` for tokens written to cache
 * - `cache_read_input_tokens` for tokens read from cache
 * 
 * Note: Anthropic's ephemeral cache doesn't distinguish between TTLs,
 * so we put all writes in the 5m bucket as a reasonable default.
 */
export function extractInvokeCacheUsage(response: AnthropicResponse | undefined): CacheUsage {
  if (!response?.usage) {
    return emptyCacheUsage();
  }

  const usage = response.usage;
  
  return {
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    // Anthropic's ephemeral cache doesn't specify TTL in response,
    // so we default to 5m bucket for all cache writes
    cacheWrite5mTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite1hTokens: 0,
  };
}

/**
 * Anthropic streaming message_delta event for final usage
 */
interface AnthropicMessageDelta {
  type: "message_delta";
  usage?: {
    output_tokens?: number;
  };
}

/**
 * Anthropic streaming message_start event with initial usage
 */
interface AnthropicMessageStart {
  type: "message_start";
  message?: {
    usage?: AnthropicUsage;
  };
}

/**
 * Parse Anthropic InvokeModel response body (Uint8Array or string) to extract cache usage
 */
export function extractInvokeCacheUsageFromBytes(body: Uint8Array | string): CacheUsage {
  try {
    const text = typeof body === "string" ? body : new TextDecoder().decode(body);
    const parsed = JSON.parse(text) as AnthropicResponse;
    return extractInvokeCacheUsage(parsed);
  } catch {
    return emptyCacheUsage();
  }
}

/**
 * Extract cache usage from Anthropic streaming events
 * 
 * In streaming mode, usage info comes in the message_start event.
 * Cache usage is typically included in the initial message metadata.
 */
export function extractInvokeStreamingCacheUsage(
  eventText: string
): { cacheUsage: CacheUsage; inputTokens: number; outputTokens: number } | null {
  try {
    const event = JSON.parse(eventText);
    
    // message_start contains initial usage including cache info
    if (event.type === "message_start" && event.message?.usage) {
      const usage = event.message.usage as AnthropicUsage;
      return {
        cacheUsage: {
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWrite5mTokens: usage.cache_creation_input_tokens ?? 0,
          cacheWrite1hTokens: 0,
        },
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      };
    }
    
    // message_delta contains final output token count
    if (event.type === "message_delta" && event.usage) {
      return {
        cacheUsage: emptyCacheUsage(),
        inputTokens: 0,
        outputTokens: event.usage.output_tokens ?? 0,
      };
    }
    
    return null;
  } catch {
    return null;
  }
}
