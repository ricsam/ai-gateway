import { describe, expect, test } from "bun:test";
import { ImageInputError, type ResolvedImage } from "../images";
import { transformRequest } from "./request";

const base = { model: "bedrock-model" } as const;
// 1x1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, "base64"));
const bytesOf = (block: unknown) => Buffer.from((block as { image: { source: { bytes: Uint8Array } } }).image.source.bytes);

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

  test("decodes image data URLs using the detected image format", () => {
    const result = transformRequest({
      ...base,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${PNG_BASE64}`, detail: "high" } },
        ],
      }],
    });
    const [text, image] = result.messages?.[0]?.content ?? [];
    expect(text).toEqual({ text: "What is this?" });
    expect((image as { image: { format: string } }).image.format).toBe("png");
    expect(bytesOf(image).equals(Buffer.from(PNG_BYTES))).toBe(true);
  });

  test("uses downloaded images for http(s) URLs and reports undownloaded URLs with their parameter", () => {
    const remoteImages = new Map<string, ResolvedImage>([["https://example.com/cat.webp", { format: "webp", bytes: new Uint8Array([1, 2, 3]) }]]);
    const request = {
      ...base,
      messages: [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: "https://example.com/cat.webp" } }] }],
    };
    const result = transformRequest(request, { remoteImages });
    expect(result.messages?.[0]?.content?.[0]).toEqual({ image: { format: "webp", source: { bytes: new Uint8Array([1, 2, 3]) } } });

    const error = (() => { try { transformRequest(request); } catch (reason) { return reason; } })();
    expect(error).toBeInstanceOf(ImageInputError);
    expect((error as ImageInputError).param).toBe("messages[0].content[0].image_url.url");
  });

  test("rejects invalid image data with the offending parameter", () => {
    const error = (() => {
      try {
        transformRequest({ ...base, messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello" },
          { role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,bm90IGFuIGltYWdl" } }] },
        ] });
      } catch (reason) { return reason; }
    })();
    expect(error).toBeInstanceOf(ImageInputError);
    expect((error as ImageInputError).param).toBe("messages[2].content[1].image_url.url");
  });

  test("maps tool results with images and text parts", () => {
    const result = transformRequest({
      ...base,
      messages: [
        { role: "user", content: "Take a screenshot" },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "screenshot", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-1", content: [
          { type: "text", text: "Captured" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ] },
      ],
    });
    const toolResult = (result.messages?.[2]?.content?.[0] as { toolResult: { toolUseId: string; content: unknown[] } }).toolResult;
    expect(toolResult.toolUseId).toBe("call-1");
    expect(toolResult.content[0]).toEqual({ text: "Captured" });
    expect((toolResult.content[1] as { image: { format: string } }).image.format).toBe("png");
  });

  test("accepts text-part arrays for system, developer, and assistant messages", () => {
    const result = transformRequest({
      ...base,
      messages: [
        { role: "system", content: [{ type: "text", text: "Rule one" }, { type: "text", text: " " }, { type: "text", text: "Rule two" }] },
        { role: "developer", content: [{ type: "text", text: "Be brief" }] },
        { role: "user", content: "Hi" },
        { role: "assistant", content: [{ type: "text", text: "Hello" }, { type: "refusal", refusal: "" }] },
        { role: "user", content: "Bye" },
      ],
    });
    expect(result.system).toEqual([{ text: "Rule one" }, { text: "Rule two" }, { text: "Be brief" }]);
    expect(result.messages?.[1]).toEqual({ role: "assistant", content: [{ text: "Hello" }] });
  });
});
