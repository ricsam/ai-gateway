/**
 * Add cache control to Anthropic InvokeModel API requests
 * 
 * This applies to the Anthropic native format used with InvokeModel.
 * Uses `cache_control: { type: "ephemeral" }` which maps to the default
 * caching behavior in Anthropic's API.
 */

/** Cache control marker for Anthropic's native format */
interface CacheControl {
  type: "ephemeral";
}

/** Anthropic content block with optional cache control */
interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

/** Anthropic message format */
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Anthropic tool definition */
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: CacheControl;
}

/** System block for Anthropic's native format */
interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

/** Anthropic InvokeModel request body */
export interface AnthropicInvokeBody {
  model?: string;
  max_tokens?: number;
  messages?: AnthropicMessage[];
  system?: string | AnthropicSystemBlock[];
  tools?: AnthropicTool[];
  [key: string]: unknown;
}

/**
 * Add cache_control to the last system block, last tool, and last message content
 */
export function addInvokeCacheControl(body: AnthropicInvokeBody): AnthropicInvokeBody {
  const result: AnthropicInvokeBody = { ...body };

  // Add cache control to system
  if (result.system) {
    result.system = addCacheControlToSystem(result.system);
  }

  // Add cache control to tools
  if (result.tools && result.tools.length > 0) {
    result.tools = addCacheControlToTools(result.tools);
  }

  // Add cache control to last message's last content block
  if (result.messages && result.messages.length > 0) {
    result.messages = addCacheControlToMessages(result.messages);
  }

  return result;
}

/**
 * Add cache_control to system content
 * If system is a string, convert it to array format with cache control
 * If system is an array, add cache control to the last block
 */
function addCacheControlToSystem(
  system: string | AnthropicSystemBlock[]
): AnthropicSystemBlock[] {
  // Convert string to array format
  if (typeof system === "string") {
    return [
      {
        type: "text",
        text: system,
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  // If already an array, add cache_control to last block
  if (system.length === 0) {
    return system;
  }

  const result = [...system];
  const lastIndex = result.length - 1;
  const lastBlock = result[lastIndex];
  
  if (lastBlock) {
    result[lastIndex] = {
      ...lastBlock,
      cache_control: { type: "ephemeral" },
    };
  }

  return result;
}

/**
 * Add cache_control to the last tool
 */
function addCacheControlToTools(tools: AnthropicTool[]): AnthropicTool[] {
  if (tools.length === 0) {
    return tools;
  }

  const result = [...tools];
  const lastIndex = result.length - 1;
  const lastTool = result[lastIndex];

  if (lastTool) {
    result[lastIndex] = {
      ...lastTool,
      cache_control: { type: "ephemeral" },
    };
  }

  return result;
}

/**
 * Add cache_control to the last content block of the last message
 */
function addCacheControlToMessages(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  const result = [...messages];
  const lastIndex = result.length - 1;
  const lastMessage = result[lastIndex];

  if (!lastMessage) {
    return result;
  }

  // Convert string content to array format if needed
  let content = lastMessage.content;
  if (typeof content === "string") {
    content = [{ type: "text", text: content }];
  }

  if (!Array.isArray(content) || content.length === 0) {
    return result;
  }

  // Add cache_control to last content block
  const newContent = [...content];
  const lastContentIndex = newContent.length - 1;
  const lastContentBlock = newContent[lastContentIndex];

  if (lastContentBlock) {
    newContent[lastContentIndex] = {
      ...lastContentBlock,
      cache_control: { type: "ephemeral" },
    };
  }

  result[lastIndex] = {
    ...lastMessage,
    content: newContent,
  };

  return result;
}
