import { describe, expect, test } from "bun:test";
import { addConverseCachePoints } from "./cache-converse";
import { extractConverseCacheUsage } from "./cache-usage";

describe("Bedrock managed caching", () => {
  test("places configured cache points after system, tools, and the last message", () => {
    const result = addConverseCachePoints({
      modelId: "bedrock-model",
      system: [{ text: "Stable prompt" }],
      toolConfig: {
        tools: [{ toolSpec: { name: "weather", inputSchema: { json: { type: "object" } } } }],
      },
      messages: [{ role: "user", content: [{ text: "Hello" }] }],
    });

    expect(result.system?.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
    expect(result.toolConfig?.tools?.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "1h" } });
    expect(result.messages?.at(-1)?.content?.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "5m" } });
  });

  test("attributes reads and writes to the correct cache buckets", () => {
    expect(extractConverseCacheUsage({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cacheReadInputTokens: 60,
      cacheWriteInputTokens: 40,
      cacheDetails: [
        { ttl: "5m", inputTokens: 15 },
        { ttl: "1h", inputTokens: 25 },
      ],
    })).toEqual({
      cacheReadTokens: 60,
      cacheWrite5mTokens: 15,
      cacheWrite1hTokens: 25,
    });
  });
});
