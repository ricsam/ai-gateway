/**
 * Transform OpenAI Chat Completion requests to AWS Bedrock Converse format
 */
import type {
  ConverseCommandInput,
  ContentBlock,
  Message,
  SystemContentBlock,
  ToolConfiguration,
  ImageFormat,
  Tool,
  ToolInputSchema,
  ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  OpenAIChatCompletionRequest,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAITool,
  OpenAIToolChoice,
} from "./types";

/**
 * Transform an OpenAI Chat Completion request to Bedrock Converse format
 */
export function transformRequest(body: OpenAIChatCompletionRequest): ConverseCommandInput {
  // Extract system messages
  const systemBlocks = extractSystemMessages(body.messages);
  
  // Transform conversation messages
  const messages = transformMessages(body.messages);
  
  // Build inference config
  const inferenceConfig = buildInferenceConfig(body);
  
  // Build tool config
  const toolConfig = buildToolConfig(body.tools, body.tool_choice);
  
  return {
    modelId: body.model,
    messages,
    ...(systemBlocks.length > 0 && { system: systemBlocks }),
    ...(Object.keys(inferenceConfig).length > 0 && { inferenceConfig }),
    ...(toolConfig && { toolConfig }),
  };
}

/**
 * Extract system and developer messages into Bedrock system blocks
 */
function extractSystemMessages(messages: OpenAIMessage[]): SystemContentBlock[] {
  const systemBlocks: SystemContentBlock[] = [];
  
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      // Skip system/developer messages with empty or blank content.
      // Bedrock rejects blank text fields in content blocks.
      if (!msg.content || msg.content.trim().length === 0) {
        console.warn("[OpenAI Transform] Skipping empty system/developer message");
        continue;
      }
      systemBlocks.push({ text: msg.content });
    }
  }
  
  return systemBlocks;
}

/**
 * Transform OpenAI messages to Bedrock Converse messages
 * Filters out system/developer messages (handled separately)
 * Consolidates consecutive same-role messages
 */
function transformMessages(messages: OpenAIMessage[]): Message[] {
  const bedrockMessages: Message[] = [];
  
  for (const msg of messages) {
    // Skip system and developer messages (handled in extractSystemMessages)
    if (msg.role === "system" || msg.role === "developer") {
      continue;
    }
    
    if (msg.role === "user") {
      const contentBlocks = transformUserContent(msg.content);
      bedrockMessages.push({
        role: "user",
        content: contentBlocks,
      });
    } else if (msg.role === "assistant") {
      const contentBlocks = transformAssistantContent(msg);
      // Skip assistant messages with no valid content blocks.
      // These are artifacts of canceled/interrupted streams persisted in
      // conversation history (e.g. content: null, no tool_calls).
      // Bedrock rejects messages with empty or blank content blocks.
      // The consolidateMessages pass below will merge any resulting
      // consecutive same-role messages.
      if (contentBlocks.length === 0) {
        console.warn("[OpenAI Transform] Skipping empty assistant message (likely from canceled stream)");
        continue;
      }
      bedrockMessages.push({
        role: "assistant",
        content: contentBlocks,
      });
    } else if (msg.role === "tool") {
      // Tool messages are wrapped in a user role with toolResult
      bedrockMessages.push({
        role: "user",
        content: [transformToolResult(msg)],
      });
    }
  }
  
  // Consolidate consecutive same-role messages
  const consolidated = consolidateMessages(bedrockMessages);
  if (consolidated.length < bedrockMessages.length) {
    console.warn("[OpenAI Transform] Consolidated", bedrockMessages.length, "messages to", consolidated.length, "(same-role merge)");
  }
  return consolidated;
}

/**
 * Transform user message content to Bedrock content blocks
 */
function transformUserContent(content: string | OpenAIContentPart[]): ContentBlock[] {
  if (typeof content === "string") {
    return [{ text: content }];
  }
  
  // Handle content parts array
  return content.map(transformContentPart);
}

/**
 * Transform a single content part to a Bedrock content block
 */
function transformContentPart(part: OpenAIContentPart): ContentBlock {
  if (part.type === "text") {
    return { text: part.text };
  }
  
  if (part.type === "image_url") {
    const { url } = part.image_url;
    
    // Handle data URIs
    if (url.startsWith("data:")) {
      const parsed = parseDataUri(url);
      if (parsed) {
        return {
          image: {
            format: parsed.format,
            source: {
              bytes: parsed.bytes,
            },
          },
        };
      }
    }
    
    // For regular URLs, we can't fetch them - use a placeholder
    // Bedrock doesn't support URL images, only base64
    console.warn("[OpenAI Transform] Non-data-URI image URL dropped, using text placeholder");
    return { text: `[Image: ${url}]` };
  }
  
  // Unknown content type - return as text placeholder
  console.warn("[OpenAI Transform] Unknown content part type:", (part as { type: string }).type);
  return { text: `[Unknown content type: ${(part as { type: string }).type}]` };
}

/**
 * Parse a data URI into format and bytes
 */
function parseDataUri(uri: string): { format: ImageFormat; bytes: Uint8Array } | null {
  const match = uri.match(/^data:image\/(png|jpeg|gif|webp);base64,(.+)$/);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  
  const format = match[1] as ImageFormat;
  const base64 = match[2];
  
  // Decode base64 to Uint8Array
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return { format, bytes };
}

/**
 * Transform assistant message to Bedrock content blocks
 */
function transformAssistantContent(msg: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  
  // Add text content if present
  if (msg.content) {
    blocks.push({ text: msg.content });
  }
  
  // Add tool use blocks if present
  if (msg.tool_calls) {
    for (const call of msg.tool_calls) {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        // If parsing fails, use the raw string as a text field
        console.warn("[OpenAI Transform] Failed to parse tool_call arguments for:", call.function.name);
        input = { _raw: call.function.arguments };
      }
      
      blocks.push({
        toolUse: {
          toolUseId: call.id,
          name: call.function.name,
          input: input as ContentBlock.ToolUseMember["toolUse"]["input"],
        },
      });
    }
  }
  
  // If no content at all, return empty array.
  // The caller (transformMessages) will skip this message entirely.
  // Bedrock rejects ContentBlock objects with blank text fields, so we must
  // never produce { text: "" }. Empty assistant messages typically come from
  // canceled/interrupted streams that were persisted in conversation history.
  return blocks;
}

/**
 * Check if a value is a plain object (not array, null, or primitive)
 * Bedrock's json field only accepts objects, not primitives or arrays
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Transform a tool message to a Bedrock toolResult block
 */
function transformToolResult(msg: { content: string; tool_call_id: string }): ContentBlock {
  // Try to parse content as JSON for structured results
  // Bedrock only accepts JSON objects in the json field, not primitives or arrays
  let resultBlocks: ToolResultContentBlock[];
  try {
    const parsed = JSON.parse(msg.content);
    if (isPlainObject(parsed)) {
      resultBlocks = [{ json: parsed } as ToolResultContentBlock];
    } else {
      // For arrays, primitives, or null - use text representation
      resultBlocks = [{ text: msg.content }];
    }
  } catch {
    resultBlocks = [{ text: msg.content }];
  }
  
  return {
    toolResult: {
      toolUseId: msg.tool_call_id,
      content: resultBlocks,
    },
  };
}

/**
 * Consolidate consecutive messages with the same role
 * Bedrock requires alternating user/assistant messages
 */
function consolidateMessages(messages: Message[]): Message[] {
  if (messages.length === 0) {
    return [];
  }
  
  const consolidated: Message[] = [];
  let currentRole: "user" | "assistant" | undefined = undefined;
  let currentContent: ContentBlock[] = [];
  
  for (const msg of messages) {
    const msgContent = Array.isArray(msg.content) ? msg.content : [];
    
    if (currentRole === undefined) {
      // First message
      currentRole = msg.role;
      currentContent = [...msgContent];
    } else if (currentRole === msg.role) {
      // Same role - merge content blocks
      currentContent = [...currentContent, ...msgContent];
    } else {
      // Different role - push current and start new
      consolidated.push({
        role: currentRole,
        content: currentContent,
      });
      currentRole = msg.role;
      currentContent = [...msgContent];
    }
  }
  
  // Push the last message
  if (currentRole !== undefined) {
    consolidated.push({
      role: currentRole,
      content: currentContent,
    });
  }
  
  return consolidated;
}

/**
 * Build inference config from OpenAI request parameters
 */
function buildInferenceConfig(body: OpenAIChatCompletionRequest): {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
} {
  const config: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  } = {};
  
  if (body.max_tokens !== undefined) {
    config.maxTokens = body.max_tokens;
  }
  
  if (body.temperature !== undefined) {
    config.temperature = body.temperature;
  }
  
  if (body.top_p !== undefined) {
    config.topP = body.top_p;
  }
  
  if (body.stop !== undefined) {
    config.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  
  return config;
}

/**
 * Build tool configuration from OpenAI tools and tool_choice
 */
function buildToolConfig(
  tools: OpenAITool[] | undefined,
  toolChoice: OpenAIToolChoice | undefined
): ToolConfiguration | undefined {
  // If tool_choice is "none", omit entire toolConfig
  if (toolChoice === "none") {
    return undefined;
  }
  
  // If no tools, return undefined
  if (!tools || tools.length === 0) {
    return undefined;
  }
  
  // Transform tools to Bedrock format
  const bedrockTools: Tool[] = tools.map((tool) => ({
    toolSpec: {
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: tool.function.parameters 
        ? { json: tool.function.parameters } as ToolInputSchema
        : undefined,
    },
  }));
  
  // Build tool choice
  let bedrockToolChoice: ToolConfiguration["toolChoice"];
  
  if (toolChoice === "auto" || toolChoice === undefined) {
    // Auto: let the model decide - omit toolChoice (uses default behavior)
    bedrockToolChoice = undefined;
  } else if (toolChoice === "required") {
    // Required: model must use a tool
    bedrockToolChoice = { any: {} };
  } else if (typeof toolChoice === "object" && toolChoice.type === "function") {
    // Specific function
    bedrockToolChoice = { tool: { name: toolChoice.function.name } };
  }
  
  return {
    tools: bedrockTools,
    ...(bedrockToolChoice && { toolChoice: bedrockToolChoice }),
  };
}
