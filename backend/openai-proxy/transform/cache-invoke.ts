/** Managed caching for Anthropic's native InvokeModel request format. */
import { planCachePoints, type CacheTtl } from "./cache-policy";
import { matchingBoundary } from "./cache-prefix";
import type { MessageCacheBoundary } from "../../conversation-cache-types";

interface CacheControl {
  type: "ephemeral";
  ttl?: CacheTtl;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: CacheControl;
}

interface AnthropicSystemBlock extends AnthropicContentBlock {
  type: "text";
  text: string;
}

export interface AnthropicInvokeBody {
  model?: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  tools?: AnthropicTool[];
  [key: string]: unknown;
}

/** Both native Invoke endpoints accept an object or a serialized JSON body. */
export function addInvokeBodyCacheControl(value: unknown, modelId: string, previous?: MessageCacheBoundary): unknown {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  // Leave malformed, non-object, and binary bodies to the provider unchanged.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || ArrayBuffer.isView(parsed)) return value;
  const body = parsed as AnthropicInvokeBody;
  // Invoke is provider-specific. Opaque profile ARNs can identify Claude via
  // its required anthropic_version field; other providers must pass through.
  if (!modelId.includes("anthropic.") && typeof body.anthropic_version !== "string") return value;
  return addInvokeCacheControl(body, previous);
}

type CacheBlock = AnthropicContentBlock | AnthropicSystemBlock | AnthropicTool;

function section(blocks: CacheBlock[], eligible: boolean) {
  return {
    existing: blocks.flatMap((block) => block?.cache_control ? [block.cache_control.ttl] : []),
    needsCheckpoint: eligible && !blocks.at(-1)?.cache_control,
    preferredTtl: "5m" as const,
  };
}

function contentBlocks(content: AnthropicMessage["content"] | undefined): AnthropicContentBlock[] {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  return Array.isArray(content) ? content : [];
}

function cacheableContent(block: AnthropicContentBlock | undefined): boolean {
  if (block?.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
  return block != null && ["image", "tool_use", "tool_result"].includes(block.type);
}

function markLast<T extends { cache_control?: CacheControl }>(blocks: T[], ttl: CacheTtl): T[] {
  const result = [...blocks];
  // Keep the historical default-5m wire format; explicit 1h is needed only
  // when filling a boundary before a caller's existing 1h checkpoint.
  result[result.length - 1] = {
    ...result[result.length - 1]!,
    cache_control: { type: "ephemeral", ...(ttl === "1h" && { ttl }) },
  };
  return result;
}

/** Fill system/tool/message boundaries, retaining caller markers and TTLs. */
export function addInvokeCacheControl(body: AnthropicInvokeBody, previous?: MessageCacheBoundary): AnthropicInvokeBody {
  previous = matchingBoundary(body, "invoke", previous);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const system = contentBlocks(body.system);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contents = messages.map((message) => contentBlocks(message?.content));
  const lastIndex = messages.length - 1;
  const boundaries = contents.flatMap((blocks, messageIndex) => blocks.map((block, contentIndex) => {
    const remembered = messageIndex === previous?.messageIndex && contentIndex === previous.contentIndex;
    const final = messageIndex === lastIndex && contentIndex === blocks.length - 1;
    return {
      messageIndex, contentIndex, remembered,
      existing: block?.cache_control ? [block.cache_control.ttl] : [],
      needsCheckpoint: !block?.cache_control && cacheableContent(block) && (remembered || final),
      preferredTtl: remembered ? previous!.ttl : "5m" as const,
      requiredTtl: remembered ? previous!.ttl : undefined,
    };
  }));
  const [toolTtl, systemTtl, ...messageTtls] = planCachePoints([
    section(tools, typeof tools.at(-1)?.name === "string"),
    section(system, system.at(-1)?.type === "text" && cacheableContent(system.at(-1))),
    ...boundaries,
  ]);
  const result = { ...body };
  if (toolTtl) result.tools = markLast(tools, toolTtl);
  if (systemTtl) result.system = markLast(system, systemTtl) as AnthropicSystemBlock[];
  for (const [index, point] of boundaries.entries()) {
    const ttl = messageTtls[index];
    if (!ttl || (point.remembered && ttl !== previous!.ttl)) continue;
    if (result.messages === body.messages) result.messages = [...messages];
    const message = result.messages![point.messageIndex]!;
    const content = [...contentBlocks(message.content)];
    content[point.contentIndex] = {
      ...content[point.contentIndex]!, cache_control: { type: "ephemeral", ...(ttl === "1h" && { ttl }) },
    };
    result.messages![point.messageIndex] = { ...message, content };
  }
  return result;
}
