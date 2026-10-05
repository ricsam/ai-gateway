/**
 * Transform AWS Bedrock Converse response to OpenAI Chat Completion format
 */
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type {
  OpenAIChatCompletionResponse,
  OpenAIToolCall,
  OpenAIResponseMessage,
} from "./types";
import { generateChatCompletionId, unixTimestamp, mapStopReason } from "./utils";
import { transformUsage } from "./usage";

/**
 * Transform a Bedrock Converse response to OpenAI Chat Completion format
 */
export function transformResponse(
  bedrockResponse: ConverseCommandOutput,
  model: string,
  requestId?: string
): OpenAIChatCompletionResponse {
  // Extract content from response
  const contentBlocks = bedrockResponse.output?.message?.content ?? [];
  
  if (contentBlocks.length === 0) {
    console.warn("[OpenAI Transform] Bedrock response has empty content blocks");
  }
  
  // Collect text content and tool calls
  let textContent = "";
  let reasoningContent = "";
  const toolCalls: OpenAIToolCall[] = [];
  
  for (const block of contentBlocks) {
    // Reasoning blocks carry summarized thinking text (empty when the model
    // omits it) or redacted content; only readable text is surfaced.
    if ("reasoningContent" in block && block.reasoningContent !== undefined) {
      const reasoningText = block.reasoningContent.reasoningText?.text;
      if (reasoningText) reasoningContent += reasoningText;
      continue;
    }

    // Check for text block
    if ("text" in block && block.text !== undefined) {
      // Concatenate text blocks with newlines if there are multiple
      if (textContent.length > 0) {
        textContent += "\n";
      }
      textContent += block.text;
    }
    
    // Check for toolUse block
    if ("toolUse" in block && block.toolUse !== undefined) {
      const toolUse = block.toolUse;
      toolCalls.push({
        id: toolUse.toolUseId ?? `call_${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: toolUse.name ?? "",
          arguments: JSON.stringify(toolUse.input ?? {}),
        },
      });
    } else if (!("text" in block)) {
      console.warn("[OpenAI Transform] Unknown Bedrock content block type:", Object.keys(block));
    }
  }
  
  // Build the message
  const message: OpenAIResponseMessage = {
    role: "assistant",
    content: textContent.length > 0 ? textContent : null,
    ...(reasoningContent.length > 0 && { reasoning_content: reasoningContent }),
  };
  
  // Add tool_calls if present
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  
  // Map stop reason
  const finishReason = mapStopReason(bedrockResponse.stopReason);
  
  return {
    id: requestId ?? generateChatCompletionId(),
    object: "chat.completion",
    created: unixTimestamp(),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: transformUsage(bedrockResponse.usage),
  };
}
