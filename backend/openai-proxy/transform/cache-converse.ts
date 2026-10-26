/**
 * Managed Converse caching: stable tools/system use 1h, the final message 5m.
 * Caller checkpoints keep their TTLs and count toward the four-point budget.
 */
import type { ConverseCommandInput, ContentBlock, SystemContentBlock, Tool } from "@aws-sdk/client-bedrock-runtime";
import { planCachePoints, type CacheTtl } from "./cache-policy";

type CacheBlock = ContentBlock | SystemContentBlock | Tool;

function section(blocks: CacheBlock[], preferredTtl: CacheTtl, enabled = true) {
  return {
    existing: blocks.flatMap((block) => block?.cachePoint ? [block.cachePoint.ttl] : []),
    needsCheckpoint: enabled && blocks.length > 0 && !blocks.at(-1)?.cachePoint,
    preferredTtl,
  };
}

/** Add missing checkpoints after tools, system, and the last message, immutably. */
export function addConverseCachePoints(request: ConverseCommandInput): ConverseCommandInput {
  const tools = Array.isArray(request.toolConfig?.tools) ? request.toolConfig.tools : [];
  const system = Array.isArray(request.system) ? request.system : [];
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const lastIndex = messages.length - 1;
  const [toolTtl, systemTtl, ...messageTtls] = planCachePoints([
    section(tools, "1h"),
    section(system, "1h"),
    ...messages.map((message, index) => section(Array.isArray(message?.content) ? message.content : [], "5m", index === lastIndex)),
  ]);
  const result = { ...request };
  if (toolTtl && request.toolConfig) {
    result.toolConfig = { ...request.toolConfig, tools: [...tools, { cachePoint: { type: "default", ttl: toolTtl } }] };
  }
  if (systemTtl) {
    result.system = [...system, { cachePoint: { type: "default", ttl: systemTtl } }];
  }
  const messageTtl = messageTtls[lastIndex];
  const lastMessage = messages[lastIndex];
  if (messageTtl && lastMessage) {
    result.messages = [...messages];
    result.messages[lastIndex] = {
      ...lastMessage,
      content: [...(lastMessage.content ?? []), { cachePoint: { type: "default", ttl: messageTtl } }],
    };
  }
  return result;
}
