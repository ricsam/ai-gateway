import { describe, expect, test } from "bun:test";
import { transformResponse } from "./response";

// AWS response types contain transport metadata that the pure transformer does not use.
function asBedrockResponse(value: unknown) {
  return value as Parameters<typeof transformResponse>[0];
}

describe("Bedrock to OpenAI response transformation", () => {
  test("maps text, tool calls, finish reason, request ID, and usage", () => {
    const result = transformResponse(asBedrockResponse({
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "Checking" },
            { toolUse: { toolUseId: "call-1", name: "weather", input: { city: "Stockholm" } } },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    }), "bedrock-model", "chatcmpl-request-1");

    expect(result.id).toBe("chatcmpl-request-1");
    expect(result.choices[0]?.finish_reason).toBe("tool_calls");
    expect(result.choices[0]?.message).toEqual({
      role: "assistant",
      content: "Checking",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "weather", arguments: '{"city":"Stockholm"}' },
      }],
    });
    expect(result.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  });

  test("surfaces summarized reasoning and ignores empty or redacted reasoning blocks", () => {
    const result = transformResponse(asBedrockResponse({
      output: {
        message: {
          role: "assistant",
          content: [
            { reasoningContent: { reasoningText: { text: "Consider the parity of both numbers.", signature: "sig" } } },
            { reasoningContent: { reasoningText: { text: "", signature: "omitted" } } },
            { reasoningContent: { redactedContent: new Uint8Array([1, 2]) } },
            { text: "The sum is even." },
          ],
        },
      },
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 40, totalTokens: 45 },
    }), "bedrock-model");

    expect(result.choices[0]?.message).toEqual({
      role: "assistant",
      content: "The sum is even.",
      reasoning_content: "Consider the parity of both numbers.",
    });
  });
});
