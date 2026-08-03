/**
 * Transform AWS Bedrock Converse stream to OpenAI Chat Completion SSE format
 */
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import type { OpenAIChatCompletionChunk, OpenAIUsage } from "./types";
import { generateChatCompletionId, unixTimestamp, mapStopReason } from "./utils";

/**
 * Transform a Bedrock Converse stream to OpenAI SSE format
 * Yields SSE-formatted strings (`data: {...}\n\n`)
 */
export async function* transformStream(
  bedrockStream: AsyncIterable<ConverseStreamOutput>,
  model: string,
  requestId?: string
): AsyncGenerator<string> {
  const id = requestId ?? generateChatCompletionId();
  const created = unixTimestamp();
  
  // Map Bedrock contentBlockIndex to OpenAI tool_calls array index
  // Bedrock uses unique block indices across all content types,
  // but OpenAI tool_calls uses 0-indexed array positions
  const blockToToolIndex = new Map<number, number>();
  let nextToolIndex = 0;
  
  for await (const event of bedrockStream) {
    // Handle messageStart event
    if (event.messageStart) {
      const chunk: OpenAIChatCompletionChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "",
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      };
      yield formatSSE(chunk);
    }
    
    // Handle contentBlockStart event
    if (event.contentBlockStart) {
      const start = event.contentBlockStart.start;
      const blockIndex = event.contentBlockStart.contentBlockIndex ?? 0;
      
      // Check if this is a toolUse start
      if (start && "toolUse" in start && start.toolUse) {
        const toolUse = start.toolUse;
        const toolIndex = nextToolIndex++;
        blockToToolIndex.set(blockIndex, toolIndex);
        
        const chunk: OpenAIChatCompletionChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    id: toolUse.toolUseId ?? `call_${crypto.randomUUID()}`,
                    type: "function",
                    function: {
                      name: toolUse.name ?? "",
                      arguments: "",
                    },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        yield formatSSE(chunk);
      }
    }
    
    // Handle contentBlockDelta event
    if (event.contentBlockDelta) {
      const delta = event.contentBlockDelta.delta;
      const blockIndex = event.contentBlockDelta.contentBlockIndex ?? 0;
      
      // Handle text delta
      if (delta && "text" in delta && delta.text !== undefined) {
        const chunk: OpenAIChatCompletionChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                content: delta.text,
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        yield formatSSE(chunk);
      }
      
      // Handle toolUse delta (arguments)
      if (delta && "toolUse" in delta && delta.toolUse) {
        const toolIndex = blockToToolIndex.get(blockIndex) ?? 0;
        const input = delta.toolUse.input ?? "";
        
        const chunk: OpenAIChatCompletionChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: toolIndex,
                    function: {
                      arguments: input,
                    },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        yield formatSSE(chunk);
      }
    }
    
    // Handle messageStop event
    if (event.messageStop) {
      const finishReason = mapStopReason(event.messageStop.stopReason);
      
      const chunk: OpenAIChatCompletionChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
      };
      yield formatSSE(chunk);
    }
    
    // Handle metadata event (contains usage info)
    if (event.metadata) {
      const inputTokens = event.metadata.usage?.inputTokens ?? 0;
      const outputTokens = event.metadata.usage?.outputTokens ?? 0;
      
      const usage: OpenAIUsage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      };
      
      const chunk: OpenAIChatCompletionChunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage,
      };
      yield formatSSE(chunk);
    }
  }
  
  // End of stream
  yield "data: [DONE]\n\n";
}

/**
 * Format a chunk as an SSE data line
 */
function formatSSE(chunk: OpenAIChatCompletionChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Extract token usage from a completed stream
 * This is useful for tracking usage after the stream completes
 */
export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Collect stream events and extract usage metadata
 * Returns both the transformed SSE strings and the usage info
 */
export async function collectStreamWithUsage(
  bedrockStream: AsyncIterable<ConverseStreamOutput>,
  model: string,
  requestId?: string
): Promise<{ chunks: string[]; usage: StreamUsage }> {
  const chunks: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  
  for await (const chunk of transformStream(bedrockStream, model, requestId)) {
    chunks.push(chunk);
    
    // Try to extract usage from metadata chunks
    if (chunk.startsWith("data: ") && !chunk.includes("[DONE]")) {
      try {
        const data = JSON.parse(chunk.slice(6));
        if (data.usage) {
          inputTokens = data.usage.prompt_tokens;
          outputTokens = data.usage.completion_tokens;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
  
  return {
    chunks,
    usage: { inputTokens, outputTokens },
  };
}
