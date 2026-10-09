/**
 * Validate and normalize OpenAI Chat Completions request bodies.
 *
 * Validation errors are client errors (HTTP 400) and carry the OpenAI-style
 * `param` path of the offending field.
 */
import { isReasoningEffort, REASONING_EFFORT_VALUES } from "@/shared/reasoning";
import { imageUrlKind } from "../images";
import type {
  OpenAIChatCompletionRequest,
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRefusalContentPart,
  OpenAITextContentPart,
  OpenAIToolCall,
} from "./types";

export class RequestValidationError extends Error {
  override name = "RequestValidationError";
  constructor(message: string, readonly param: string | null = null, readonly code = "invalid_request") { super(message); }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

function textPart(part: Json, param: string): OpenAITextContentPart {
  if (typeof part.text !== "string") throw new RequestValidationError(`${param}.text must be a string`, `${param}.text`);
  return { type: "text", text: part.text };
}

function imagePart(part: Json, param: string): OpenAIContentPart {
  const raw = part.image_url;
  const imageUrl = typeof raw === "string" ? { url: raw } : raw;
  if (!isObject(imageUrl) || typeof imageUrl.url !== "string") {
    throw new RequestValidationError(`${param}.image_url.url must be a string`, `${param}.image_url.url`);
  }
  if (!imageUrlKind(imageUrl.url)) {
    throw new RequestValidationError(`${param}.image_url.url must be a base64 data URL or an http(s) URL`, `${param}.image_url.url`, "invalid_image_url");
  }
  const detail = imageUrl.detail === "auto" || imageUrl.detail === "low" || imageUrl.detail === "high" ? imageUrl.detail : undefined;
  return { type: "image_url", image_url: { url: imageUrl.url, ...(detail && { detail }) } };
}

function contentParts<T>(content: unknown[], param: string, allowed: Record<string, (part: Json, param: string) => T>): T[] {
  return content.map((part, index) => {
    const partParam = `${param}[${index}]`;
    if (!isObject(part) || typeof part.type !== "string") throw new RequestValidationError(`${partParam} must be a content part object`, partParam);
    const convert = allowed[part.type];
    if (!convert) {
      const supported = Object.keys(allowed).join(", ");
      throw new RequestValidationError(`${partParam}.type "${part.type}" is not supported here; supported types: ${supported}`, `${partParam}.type`);
    }
    return convert(part, partParam);
  });
}

function toolCalls(value: unknown, param: string): OpenAIToolCall[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RequestValidationError(`${param} must be an array`, param);
  return value.map((call, index) => {
    const callParam = `${param}[${index}]`;
    if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== "string" || !call.function.name) {
      throw new RequestValidationError(`${callParam} must include function.name`, `${callParam}.function.name`);
    }
    if (typeof call.id !== "string" || !call.id) throw new RequestValidationError(`${callParam}.id must be a non-empty string`, `${callParam}.id`);
    const args = call.function.arguments;
    const serialized = args === undefined || args === null ? "{}" : typeof args === "string" ? args : JSON.stringify(args);
    return { id: call.id, type: "function", function: { name: call.function.name, arguments: serialized } };
  });
}

function validateMessage(message: unknown, index: number): OpenAIMessage {
  const param = `messages[${index}]`;
  if (!isObject(message) || typeof message.role !== "string") throw new RequestValidationError(`${param} is invalid`, param);
  const content = message.content;
  const contentParam = `${param}.content`;
  const name = typeof message.name === "string" ? message.name : undefined;
  switch (message.role) {
    case "system":
    case "developer": {
      if (typeof content === "string") return { role: message.role, content, ...(name && { name }) };
      if (!Array.isArray(content)) throw new RequestValidationError(`${contentParam} must be a string or an array of text parts`, contentParam);
      return { role: message.role, content: contentParts(content, contentParam, { text: textPart }), ...(name && { name }) };
    }
    case "user": {
      if (typeof content === "string") return { role: "user", content, ...(name && { name }) };
      if (!Array.isArray(content)) throw new RequestValidationError(`${contentParam} must be a string or an array of content parts`, contentParam);
      return { role: "user", content: contentParts<OpenAIContentPart>(content, contentParam, { text: textPart, image_url: imagePart }), ...(name && { name }) };
    }
    case "assistant": {
      const calls = toolCalls(message.tool_calls, `${param}.tool_calls`);
      let normalized: string | null | Array<OpenAITextContentPart | OpenAIRefusalContentPart>;
      if (content === undefined || content === null) normalized = null;
      else if (typeof content === "string") normalized = content;
      else if (Array.isArray(content)) {
        normalized = contentParts<OpenAITextContentPart | OpenAIRefusalContentPart>(content, contentParam, {
          text: textPart,
          refusal: (part, partParam) => {
            if (typeof part.refusal !== "string") throw new RequestValidationError(`${partParam}.refusal must be a string`, `${partParam}.refusal`);
            return { type: "refusal", refusal: part.refusal };
          },
        });
      } else throw new RequestValidationError(`${contentParam} is invalid`, contentParam);
      return { role: "assistant", content: normalized, ...(calls && { tool_calls: calls }), ...(name && { name }) };
    }
    case "tool": {
      if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
        throw new RequestValidationError(`${param}.tool_call_id must be a non-empty string`, `${param}.tool_call_id`);
      }
      if (typeof content === "string") return { role: "tool", content, tool_call_id: message.tool_call_id };
      if (!Array.isArray(content)) throw new RequestValidationError(`${contentParam} must be a string or an array of content parts`, contentParam);
      return { role: "tool", content: contentParts<OpenAIContentPart>(content, contentParam, { text: textPart, image_url: imagePart }), tool_call_id: message.tool_call_id };
    }
    default:
      throw new RequestValidationError(`${param}.role is not supported`, `${param}.role`);
  }
}

function positiveInteger(body: Json, key: "max_tokens" | "max_completion_tokens" | "max_output_tokens"): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RequestValidationError(`${key} must be a positive integer`, key, "invalid_max_tokens");
  }
  return value;
}

/** Validate a parsed JSON body and return a normalized chat completion request. */
export function validateChatCompletionRequest(input: unknown): OpenAIChatCompletionRequest {
  if (!isObject(input)) throw new RequestValidationError("Request body must be a JSON object");
  if (!input.model || typeof input.model !== "string") throw new RequestValidationError("model is required", "model", "missing_model");
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new RequestValidationError("messages is required and must be a non-empty array", "messages", "missing_messages");
  }
  if (input.n !== undefined && input.n !== null && input.n !== 1) throw new RequestValidationError("Only n=1 is supported", "n");
  if (input.temperature !== undefined && input.temperature !== null && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2)) {
    throw new RequestValidationError("temperature must be between 0 and 2", "temperature");
  }
  if (input.top_p !== undefined && input.top_p !== null && (typeof input.top_p !== "number" || !Number.isFinite(input.top_p) || input.top_p < 0 || input.top_p > 1)) {
    throw new RequestValidationError("top_p must be between 0 and 1", "top_p");
  }
  if (input.tools !== undefined && input.tools !== null && !Array.isArray(input.tools)) throw new RequestValidationError("tools must be an array", "tools");
  const reasoningEffort = input.reasoning_effort ?? undefined;
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
    throw new RequestValidationError(`reasoning_effort must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`, "reasoning_effort", "invalid_reasoning_effort");
  }
  const maxTokens = positiveInteger(input, "max_tokens");
  const maxCompletionTokens = positiveInteger(input, "max_completion_tokens");
  const maxOutputTokens = positiveInteger(input, "max_output_tokens");
  const messages = input.messages.map(validateMessage);

  const normalized = { ...input, messages } as OpenAIChatCompletionRequest;
  delete normalized.reasoning_effort;
  delete normalized.max_completion_tokens;
  delete normalized.max_output_tokens;
  delete normalized.max_tokens;
  if (reasoningEffort !== undefined) normalized.reasoning_effort = reasoningEffort;
  const effectiveMaxTokens = maxCompletionTokens ?? maxOutputTokens ?? maxTokens;
  if (effectiveMaxTokens !== undefined) normalized.max_tokens = effectiveMaxTokens;
  if (input.temperature === null) delete normalized.temperature;
  if (input.top_p === null) delete normalized.top_p;
  if (input.tools === null) delete normalized.tools;
  // Some clients serialize unset options as explicit nulls.
  if (input.tool_choice === null) delete normalized.tool_choice;
  if (input.stop === null) delete normalized.stop;
  return normalized;
}

/** Collect distinct http(s) image URLs with the request parameter path of their first use. */
export function collectRemoteImageUrls(messages: OpenAIMessage[]): Map<string, string> {
  const urls = new Map<string, string>();
  messages.forEach((message, messageIndex) => {
    if ((message.role !== "user" && message.role !== "tool") || typeof message.content === "string") return;
    message.content.forEach((part, partIndex) => {
      if (part.type !== "image_url" || imageUrlKind(part.image_url.url) !== "remote" || urls.has(part.image_url.url)) return;
      urls.set(part.image_url.url, `messages[${messageIndex}].content[${partIndex}].image_url.url`);
    });
  });
  return urls;
}
