/**
 * OpenAI Chat Completions API Type Definitions
 * 
 * These types define the OpenAI-compatible format for the proxy endpoint.
 * The proxy translates between these types and AWS Bedrock Converse API.
 */
import type { ReasoningEffort } from "@/shared/reasoning";

// ============================================================================
// Content Parts
// ============================================================================

export interface OpenAITextContentPart {
  type: "text";
  text: string;
}

export interface OpenAIImageContentPart {
  type: "image_url";
  /** Clients occasionally send the URL string directly; validation normalizes it to the object form. */
  image_url: {
    /** A base64 `data:image/...` URL or a public http(s) URL. */
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

export interface OpenAIRefusalContentPart {
  type: "refusal";
  refusal: string;
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

// ============================================================================
// Tool Types
// ============================================================================

export interface OpenAIFunctionDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIFunctionDefinition;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

/** Tool choice can be a string or an object specifying a specific function */
export type OpenAIToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "function"; function: { name: string } };

// ============================================================================
// Messages
// ============================================================================

export interface OpenAISystemMessage {
  role: "system";
  content: string | OpenAITextContentPart[];
  name?: string;
}

export interface OpenAIDeveloperMessage {
  role: "developer";
  content: string | OpenAITextContentPart[];
  name?: string;
}

export interface OpenAIUserMessage {
  role: "user";
  content: string | OpenAIContentPart[];
  name?: string;
}

export interface OpenAIAssistantMessage {
  role: "assistant";
  content?: string | null | Array<OpenAITextContentPart | OpenAIRefusalContentPart>;
  name?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolMessage {
  role: "tool";
  /** Image parts are a gateway extension mapped to Bedrock tool-result image blocks. */
  content: string | OpenAIContentPart[];
  tool_call_id: string;
}

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIDeveloperMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

// ============================================================================
// Request Types
// ============================================================================

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  /** Newer alias for max_tokens; takes precedence over other output-limit fields. */
  max_completion_tokens?: number;
  /** Gateway alias for max_tokens; takes precedence over max_tokens only. */
  max_output_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  reasoning_effort?: ReasoningEffort | null;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  // These are accepted but not mapped to Bedrock
  frequency_penalty?: number;
  presence_penalty?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
  seed?: number;
  user?: string;
  response_format?: { type: "text" | "json_object" };
}

// ============================================================================
// Response Types
// ============================================================================

export interface OpenAIUsage {
  /** Total input, including cache reads and cache writes. */
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens: number;
    /** LiteLLM extension for newly cached input. */
    cache_creation_tokens: number;
  };
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Authoritative credit settlement metadata returned to the built-in playground. */
export interface OpenAICreditUsage {
  actual_cost: number;
  credits_charged: number;
  balance_after: number;
  partially_charged: boolean;
}

export interface OpenAIResponseMessage {
  role: "assistant";
  content: string | null;
  /** Non-standard extension carrying summarized model reasoning when the model returns it. */
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIResponseMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs: null;
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
  /** Non-standard compatibility extension returned only for session-authenticated playground requests. */
  credit_usage?: OpenAICreditUsage;
  system_fingerprint?: string;
}

// ============================================================================
// Streaming Types
// ============================================================================

export interface OpenAIDeltaMessage {
  role?: "assistant";
  content?: string | null;
  /** Non-standard compatibility extension used by the built-in model playground. */
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIChunkChoice {
  index: number;
  delta: OpenAIDeltaMessage;
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs: null;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChunkChoice[];
  usage?: OpenAIUsage;
  /** Non-standard compatibility extension returned only for session-authenticated playground requests. */
  credit_usage?: OpenAICreditUsage;
  system_fingerprint?: string;
}

// ============================================================================
// Error Types
// ============================================================================

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
    param?: string | null;
  };
}

export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "timeout_error"
  | "server_error";
