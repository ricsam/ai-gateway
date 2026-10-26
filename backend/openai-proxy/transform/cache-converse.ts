/**
 * Managed Converse caching: stable tools/system use 1h, the final message 5m.
 * Caller checkpoints keep their TTLs and count toward the four-point budget.
 */
import type { ConverseCommandInput, ContentBlock, SystemContentBlock, Tool } from "@aws-sdk/client-bedrock-runtime";
import { planCachePoints, type CacheTtl } from "./cache-policy";
import { matchingBoundary } from "./cache-prefix";
import type { MessageCacheBoundary } from "../../conversation-cache-types";

type CacheBlock = ContentBlock | SystemContentBlock | Tool;

function section(blocks: CacheBlock[], preferredTtl: CacheTtl, enabled = true) {
  return {
    existing: blocks.flatMap((block) => block?.cachePoint ? [block.cachePoint.ttl] : []),
    needsCheckpoint: enabled && blocks.length > 0 && !blocks.at(-1)?.cachePoint,
    preferredTtl,
  };
}

/** Add missing checkpoints after tools, system, and the last message, immutably. */
export function addConverseCachePoints(request: ConverseCommandInput, previous?: MessageCacheBoundary): ConverseCommandInput {
  previous = matchingBoundary(request, "converse", previous);
  const tools = Array.isArray(request.toolConfig?.tools) ? request.toolConfig.tools : [];
  const system = Array.isArray(request.system) ? request.system : [];
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const lastIndex = messages.length - 1;
  const boundaries = messages.flatMap((message, messageIndex) => {
    const content = Array.isArray(message?.content) ? message.content : [];
    let contentIndex = -1;
    return content.map((block, rawIndex) => {
      if (!block?.cachePoint) contentIndex++;
      const remembered = !!block && !block.cachePoint && messageIndex === previous?.messageIndex && contentIndex === previous.contentIndex;
      const final = messageIndex === lastIndex && rawIndex === content.length - 1;
      return {
        messageIndex, rawIndex, remembered,
        existing: block?.cachePoint ? [block.cachePoint.ttl] : [],
        needsCheckpoint: !!block && !block.cachePoint && !content[rawIndex + 1]?.cachePoint && (remembered || final),
        preferredTtl: remembered ? previous!.ttl : "5m" as const,
        requiredTtl: remembered ? previous!.ttl : undefined,
      };
    });
  });
  const [toolTtl, systemTtl, ...messageTtls] = planCachePoints([
    section(tools, "1h"), section(system, "1h"), ...boundaries,
  ]);
  const result = { ...request };
  if (toolTtl && request.toolConfig) {
    result.toolConfig = { ...request.toolConfig, tools: [...tools, { cachePoint: { type: "default", ttl: toolTtl } }] };
  }
  if (systemTtl) {
    result.system = [...system, { cachePoint: { type: "default", ttl: systemTtl } }];
  }
  // Reverse insertion keeps raw block offsets stable, including boundaries in
  // a message extended by OpenAI's same-role consolidation.
  for (let index = boundaries.length - 1; index >= 0; index--) {
    const point = boundaries[index]!;
    const ttl = messageTtls[index];
    if (!ttl || (point.remembered && ttl !== previous!.ttl)) continue;
    const message = (result.messages ?? messages)[point.messageIndex]!;
    const content = [...message.content!];
    content.splice(point.rawIndex + 1, 0, { cachePoint: { type: "default", ttl } });
    if (result.messages === request.messages) result.messages = [...messages];
    result.messages![point.messageIndex] = { ...message, content };
  }
  return result;
}
