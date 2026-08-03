import { describe, expect, test } from "bun:test";
import { transformRequest } from "./request";

const base = { model: "bedrock-model" } as const;

describe("OpenAI to Bedrock request transformation", () => {
  test("separates system instructions and maps inference controls", () => {
    const result = transformRequest({
      ...base,
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 200,
      temperature: 0.2,
      top_p: 0.8,
      stop: ["done"],
    });

    expect(result.system).toEqual([{ text: "Be concise" }]);
    expect(result.messages).toEqual([{ role: "user", content: [{ text: "Hello" }] }]);
    expect(result.inferenceConfig).toEqual({
      maxTokens: 200,
      temperature: 0.2,
      topP: 0.8,
      stopSequences: ["done"],
    });
  });

  test("maps tools, forced tool choice, calls, and results", () => {
    const result = transformRequest({
      ...base,
      messages: [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Stockholm"}' },
          }],
        },
        { role: "tool", tool_call_id: "call-1", content: '{"temperature":18}' },
      ],
      tools: [{
        type: "function",
        function: {
          name: "weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }],
      tool_choice: { type: "function", function: { name: "weather" } },
    });

    expect(result.toolConfig?.toolChoice).toEqual({ tool: { name: "weather" } });
    expect(result.toolConfig?.tools).toHaveLength(1);
    expect(result.messages?.[1]?.content?.[0]).toEqual({
      toolUse: { toolUseId: "call-1", name: "weather", input: { city: "Stockholm" } },
    });
    expect(result.messages?.[2]?.content?.[0]).toEqual({
      toolResult: { toolUseId: "call-1", content: [{ json: { temperature: 18 } }] },
    });
  });
});
