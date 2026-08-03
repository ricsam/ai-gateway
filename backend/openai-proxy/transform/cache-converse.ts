/**
 * Add cache points to Converse API requests
 * 
 * Cache strategy:
 * - System prompts: 1h TTL (stable, reused across conversations)
 * - Tools: 1h TTL (stable, reused across conversations)
 * - Last message content: 5m TTL (changes frequently)
 */
import type {
  ConverseCommandInput,
  SystemContentBlock,
  ContentBlock,
  Tool,
} from "@aws-sdk/client-bedrock-runtime";

/**
 * Add cache points to the last system block, last tool, and last message content
 */
export function addConverseCachePoints(request: ConverseCommandInput): ConverseCommandInput {
  const result: ConverseCommandInput = { ...request };

  // Add cache point to system blocks
  if (result.system && result.system.length > 0) {
    result.system = addCachePointToSystemBlocks(result.system, "1h");
  }

  // Add cache point to tools
  if (result.toolConfig?.tools && result.toolConfig.tools.length > 0) {
    result.toolConfig = {
      ...result.toolConfig,
      tools: addCachePointToTools(result.toolConfig.tools, "1h"),
    };
  }

  // Add cache point to last message's last content block
  if (result.messages && result.messages.length > 0) {
    result.messages = addCachePointToMessages(result.messages, "5m");
  }

  return result;
}

/**
 * Add a cache point block after the last system content block
 */
function addCachePointToSystemBlocks(
  blocks: SystemContentBlock[],
  ttl: "5m" | "1h"
): SystemContentBlock[] {
  if (blocks.length === 0) {
    return blocks;
  }

  // Create a copy and append cache point
  const result = [...blocks];
  const cachePoint: SystemContentBlock = {
    cachePoint: { type: "default", ttl },
  };
  result.push(cachePoint);

  return result;
}

/**
 * Add a cache point block after the last tool
 */
function addCachePointToTools(
  tools: Tool[],
  ttl: "5m" | "1h"
): Tool[] {
  if (tools.length === 0) {
    return tools;
  }

  // Create a copy and append cache point
  const result = [...tools];
  const cachePoint: Tool = {
    cachePoint: { type: "default", ttl },
  };
  result.push(cachePoint);

  return result;
}

/**
 * Add a cache point to the last content block of the last message
 */
function addCachePointToMessages(
  messages: ConverseCommandInput["messages"],
  ttl: "5m" | "1h"
): ConverseCommandInput["messages"] {
  if (!messages || messages.length === 0) {
    return messages;
  }

  // Copy messages array
  const result = [...messages];
  const lastIndex = result.length - 1;
  const lastMessage = result[lastIndex];

  if (!lastMessage) {
    return result;
  }

  // Get content array from last message
  const content = lastMessage.content;
  if (!content || !Array.isArray(content) || content.length === 0) {
    return result;
  }

  // Create new content array with cache point appended
  const newContent: ContentBlock[] = [...content];
  const cachePoint: ContentBlock = {
    cachePoint: { type: "default", ttl },
  };
  newContent.push(cachePoint);

  // Update the last message with new content
  result[lastIndex] = {
    ...lastMessage,
    content: newContent,
  };

  return result;
}
