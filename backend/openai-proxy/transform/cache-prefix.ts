import { createHash } from "node:crypto";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { MessageCacheBoundary } from "../../conversation-cache-types";
import type { AnthropicInvokeBody } from "./cache-invoke";

export type CacheFormat = "converse" | "invoke";
type Fields = Record<string, unknown>;
function object(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove only provider cache annotations, never similarly named tool-schema fields. */
function blocks(value: unknown, format: CacheFormat): Fields[] | undefined {
  if (format === "invoke" && typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value) || value.some(block => !object(block))) return undefined;
  if (format === "converse") return value.filter(block => !block.cachePoint);
  return value.map(({ cache_control: _cacheControl, ...block }) => block);
}

export function cachePrefixHash(
  request: ConverseCommandInput | AnthropicInvokeBody,
  format: CacheFormat,
  position: Pick<MessageCacheBoundary, "messageIndex" | "contentIndex">,
): string | undefined {
  const { messageIndex, contentIndex } = position;
  if (!Number.isInteger(messageIndex) || messageIndex < 0 || !Number.isInteger(contentIndex) || contentIndex < 0) return undefined;
  const { messages: rawMessages, ...options } = request;
  if (!Array.isArray(rawMessages) || messageIndex >= rawMessages.length) return undefined;
  const messages: Fields[] = [];
  for (let i = 0; i <= messageIndex; i++) {
    const message = rawMessages[i];
    if (!object(message)) return undefined;
    const content = blocks(message.content, format);
    if (!content || (i === messageIndex && contentIndex >= content.length)) return undefined;
    messages.push({ ...message, content: i === messageIndex ? content.slice(0, contentIndex + 1) : content });
  }
  if (options.system !== undefined) {
    const system = blocks(options.system, format);
    if (!system) return undefined;
    options.system = system as typeof options.system;
  }
  if (format === "converse") {
    const config = (options as ConverseCommandInput).toolConfig;
    if (config?.tools) options.toolConfig = { ...config, tools: blocks(config.tools, format) };
  } else {
    const body = options as AnthropicInvokeBody;
    if (body.tools) body.tools = blocks(body.tools, format) as unknown as typeof body.tools;
    delete body.cache_control;
  }
  // Conservatively include provider options as well as the complete prefix.
  // Only a matching hash can authorize restoring a remembered boundary.
  return createHash("sha256").update(JSON.stringify({ options, messages })).digest("hex");
}

export function matchingBoundary(
  request: ConverseCommandInput | AnthropicInvokeBody,
  format: CacheFormat,
  previous: MessageCacheBoundary | undefined,
): MessageCacheBoundary | undefined {
  return previous && cachePrefixHash(request, format, previous) === previous.prefixHash ? previous : undefined;
}

/** Remember only a checkpoint actually sent at the end of this request's input. */
export function finalCacheBoundary(
  request: ConverseCommandInput | AnthropicInvokeBody,
  format: CacheFormat,
): MessageCacheBoundary | undefined {
  const messages = request.messages;
  if (!Array.isArray(messages) || !messages.length) return undefined;
  const messageIndex = messages.length - 1;
  const content = messages[messageIndex]?.content;
  if (!Array.isArray(content) || !content.length) return undefined;
  const last = content.at(-1);
  if (!object(last)) return undefined;
  const marker = format === "converse" ? last.cachePoint : last.cache_control;
  if (!object(marker)) return undefined;
  const ttl = marker.ttl ?? "5m";
  if (ttl !== "5m" && ttl !== "1h") return undefined;
  const contentIndex = (blocks(content, format)?.length ?? 0) - 1;
  const position = { messageIndex, contentIndex };
  const prefixHash = cachePrefixHash(request, format, position);
  return prefixHash ? { ...position, prefixHash, ttl } : undefined;
}
