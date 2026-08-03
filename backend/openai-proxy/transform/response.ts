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
  const toolCalls: OpenAIToolCall[] = [];
  
  for (const block of contentBlocks) {
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
  };
  
  // Add tool_calls if present
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  
  // Extract usage
  const inputTokens = bedrockResponse.usage?.inputTokens ?? 0;
  const outputTokens = bedrockResponse.usage?.outputTokens ?? 0;
  
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
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
