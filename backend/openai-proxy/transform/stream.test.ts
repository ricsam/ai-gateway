import { describe, expect, test } from "bun:test";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { transformStream } from "./stream";

async function* events(values: ConverseStreamOutput[]) {
  yield* values;
}

describe("Bedrock streaming to OpenAI SSE transformation", () => {
  test("streams text, tool arguments, usage, finish reason, and DONE", async () => {
    const chunks: string[] = [];
    for await (const chunk of transformStream(events([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call-1", name: "weather" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"Stockholm"}' } } } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, metrics: { latencyMs: 5 } } },
    ]), "bedrock-model", "chatcmpl-stream-1")) chunks.push(chunk);

    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
    const payloads = chunks.slice(0, -1).map((chunk) => JSON.parse(chunk.slice(6)));
    expect(payloads.every((payload) => payload.id === "chatcmpl-stream-1")).toBe(true);
    expect(payloads[1].choices[0].delta.content).toBe("Hello");
    expect(payloads[2].choices[0].delta.tool_calls[0].function.name).toBe("weather");
    expect(payloads[3].choices[0].delta.tool_calls[0].function.arguments).toBe('{"city":');
    expect(payloads[5].choices[0].finish_reason).toBe("tool_calls");
    expect(payloads[6].usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });
});
