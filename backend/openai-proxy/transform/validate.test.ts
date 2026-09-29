import { describe, expect, test } from "bun:test";
import { collectRemoteImageUrls, RequestValidationError, validateChatCompletionRequest } from "./validate";

const valid = { model: "m", messages: [{ role: "user", content: "Hi" }] };

function failure(input: unknown): RequestValidationError {
  try {
    validateChatCompletionRequest(input);
  } catch (error) {
    if (error instanceof RequestValidationError) return error;
    throw error;
  }
  throw new Error("expected validation to fail");
}

describe("chat completion request validation", () => {
  test("keeps historical error codes for missing fields", () => {
    expect(failure({ messages: valid.messages })).toMatchObject({ code: "missing_model", param: "model" });
    expect(failure({ model: "m", messages: [] })).toMatchObject({ code: "missing_messages", param: "messages" });
    expect(failure({ ...valid, n: 2 })).toMatchObject({ code: "invalid_request", param: "n" });
    expect(failure({ ...valid, temperature: 3 }).param).toBe("temperature");
    expect(failure({ ...valid, max_tokens: 1.5 })).toMatchObject({ code: "invalid_max_tokens", param: "max_tokens" });
  });

  test("validates reasoning_effort values and ignores null", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(validateChatCompletionRequest({ ...valid, reasoning_effort: effort }).reasoning_effort).toBe(effort as never);
    }
    expect(validateChatCompletionRequest({ ...valid, reasoning_effort: null }).reasoning_effort).toBeUndefined();
    expect(failure({ ...valid, reasoning_effort: "extreme" })).toMatchObject({ code: "invalid_reasoning_effort", param: "reasoning_effort" });
  });

  test("uses max_completion_tokens as the output limit alias", () => {
    expect(validateChatCompletionRequest({ ...valid, max_completion_tokens: 300 }).max_tokens).toBe(300);
    expect(validateChatCompletionRequest({ ...valid, max_tokens: 100, max_completion_tokens: 300 }).max_tokens).toBe(300);
    expect(validateChatCompletionRequest({ ...valid, max_tokens: 100 }).max_tokens).toBe(100);
    expect(failure({ ...valid, max_completion_tokens: 0 }).param).toBe("max_completion_tokens");
  });

  test("drops explicit null options", () => {
    const body = validateChatCompletionRequest({
      ...valid, temperature: null, top_p: null, stop: null, tool_choice: null, max_tokens: null, n: null,
      tools: [{ type: "function", function: { name: "f" } }],
    });
    for (const key of ["temperature", "top_p", "stop", "tool_choice", "max_tokens"]) expect(key in body).toBe(false);
    expect(body.tools).toHaveLength(1);
  });

  test("normalizes image parts and tool calls", () => {
    const body = validateChatCompletionRequest({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: "https://example.com/a.png" }, { type: "text", text: "?" }] },
        { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: { a: 1 } } }] },
        { role: "tool", tool_call_id: "c1", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "bogus" } }] },
      ],
    });
    expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }, { type: "text", text: "?" }] });
    expect(body.messages[1]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{\"a\":1}" } }] });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] });
  });

  test("rejects unsupported parts, schemes, and malformed messages with parameter paths", () => {
    expect(failure({ model: "m", messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] }).param).toBe("messages[0].content[0].type");
    expect(failure({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "file:///etc/passwd" } }] }] }))
      .toMatchObject({ code: "invalid_image_url", param: "messages[0].content[0].image_url.url" });
    expect(failure({ model: "m", messages: [{ role: "system", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }).param).toBe("messages[0].content[0].type");
    expect(failure({ model: "m", messages: [{ role: "tool", content: "result" }] }).param).toBe("messages[0].tool_call_id");
    expect(failure({ model: "m", messages: [{ role: "assistant", tool_calls: [{ id: "x", function: {} }] }] }).param).toBe("messages[0].tool_calls[0].function.name");
    expect(failure({ model: "m", messages: [{ role: "function", content: "x" }] }).param).toBe("messages[0].role");
  });

  test("collects distinct remote image URLs from user and tool messages", () => {
    const body = validateChatCompletionRequest({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
        { role: "assistant", content: "ok", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "http://example.com/b.png" } }] },
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }] },
      ],
    });
    expect([...collectRemoteImageUrls(body.messages)]).toEqual([
      ["https://example.com/a.png", "messages[0].content[0].image_url.url"],
      ["http://example.com/b.png", "messages[2].content[1].image_url.url"],
    ]);
  });
});
