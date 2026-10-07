import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ConverseStreamCommand, InvokeModelWithResponseStreamCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";

// The handler's persistence, authentication, billing, settings, and AWS client
// dependencies are replaced so the full request pipeline runs in memory.
import { resolveModelCatalog, type ModelCatalog, type RoutingAlias, type RoutingApp } from "../model-routing";
type ModelRow = Record<string, unknown>;
let modelRow: ModelRow | null = null;
let aliases: RoutingAlias[] = [];
let apps: RoutingApp[] = [];
let settlements: Record<string, unknown>[] = [];
let remoteImagesEnabled = true;
let sent: Array<{ streaming: boolean; input: ConverseCommandInput }> = [];
let converseOutput: unknown;
let streamEvents: unknown[] = [];

mock.module("../model-catalog", () => ({
  listAvailableModels: async () => resolveModelCatalog({ models: modelRow ? [modelRow] : [], aliases, apps } as ModelCatalog),
  resolveModel: async (id: string) => resolveModelCatalog({ models: modelRow ? [modelRow] : [], aliases, apps } as ModelCatalog).find((entry) => entry.modelId === id),
}));
mock.module("../proxy-auth", () => {
  const principal = { userId: "user-1234567890", credentialType: "api_key", credentialId: "key-1", scopes: new Set(["ai.invoke"]) };
  return {
    authenticateApiKeyPrincipal: async () => ({ ok: true, principal }),
    authenticateSessionPrincipal: async () => ({ ok: true, principal: { ...principal, credentialType: "session" } }),
    requireProxyScope: (result: unknown) => result,
  };
});
mock.module("../credit-service", () => ({
  checkBalance: async () => 100,
  calculateCostBreakdown: () => ({ total: 0.01, inputCost: 0.005, outputCost: 0.005, cacheReadCost: 0, cacheWrite5mCost: 0, cacheWrite1hCost: 0 }),
  deductCredits: async (input: Record<string, unknown>) => {
    settlements.push(input);
    return { actualCost: 0.01, creditsCharged: 0.01, balanceAfter: 99.99, partiallyCharged: false };
  },
}));
mock.module("../config-service", () => ({ getRemoteImageUrlsEnabled: async () => remoteImagesEnabled }));
mock.module("../bedrock", () => ({
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
  getBedrockClient: async () => ({
    send: async (command: { input: ConverseCommandInput }) => {
      const streaming = command instanceof ConverseStreamCommand;
      sent.push({ streaming, input: command.input });
      if (command instanceof InvokeModelWithResponseStreamCommand) return { body: (async function* () { yield { chunk: { bytes: new TextEncoder().encode('{"type":"message_stop"}') } }; })() };
      if (!streaming) return converseOutput;
      return { stream: (async function* () { for (const event of streamEvents) yield event; })() };
    },
  }),
}));

const { handleOpenAIProxy } = await import("./handler");
const { handleBedrockProxy } = await import("../bedrock-proxy");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function model(overrides: ModelRow = {}): ModelRow {
  return {
    id: "model-1", name: "Opus", createdAt: new Date(0), modelId: "global.anthropic.claude-opus-4-7", inputPricePerMTok: 5, outputPricePerMTok: 25,
    cacheReadPricePerMTok: null, cacheWrite5mPricePerMTok: null, cacheWrite1hPricePerMTok: null,
    managedCache: false, region: null, maxOutputTokens: 64000, thinking: true, reasoningMode: "auto",
    defaultReasoningEffort: null, enabled: true, provider: "bedrock", ...overrides,
  };
}

function call(body: unknown) {
  return handleOpenAIProxy(new Request("https://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer aig_test" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  modelRow = model();
  aliases = []; apps = [];
  remoteImagesEnabled = true;
  sent = [];
  streamEvents = [];
  settlements = [];
  converseOutput = {
    output: { message: { role: "assistant", content: [
      { reasoningContent: { reasoningText: { text: "Looking at the image.", signature: "sig" } } },
      { text: "A single transparent pixel." },
    ] } },
    stopReason: "end_turn",
    usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
  };
});

describe("OpenAI-compatible handler", () => {
  for (const stream of [false, true]) {
    test(`reports all context tokens with separate billing categories (stream=${stream})`, async () => {
      const usage = {
        inputTokens: 2, outputTokens: 510, totalTokens: 512,
        cacheReadInputTokens: 7683, cacheWriteInputTokens: 1412,
        cacheDetails: [{ ttl: "5m", inputTokens: 1000 }, { ttl: "1h", inputTokens: 412 }],
      };
      converseOutput = { output: { message: { role: "assistant", content: [{ text: "Done" }] } }, stopReason: "end_turn", usage };
      streamEvents = [
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Done" } } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage } },
      ];
      const response = await call({ model: "global.anthropic.claude-opus-4-7", stream, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Hi" }] });
      expect(response.status).toBe(200);
      const body = stream
        ? (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: {")).map((frame) => JSON.parse(frame.slice(6))).find((frame) => frame.usage)
        : await response.json();
      expect(body.usage).toMatchObject({
        prompt_tokens: 9097, completion_tokens: 510, total_tokens: 9607,
        prompt_tokens_details: { cached_tokens: 7683, cache_creation_tokens: 1412 },
      });
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toMatchObject({ inputTokens: 2, outputTokens: 510, cacheReadTokens: 7683, cacheWrite5mTokens: 1000, cacheWrite1hTokens: 412 });
    });
  }

  function configureAlias() {
    aliases = [{ id: "alias-1", modelId: "opus-max-thinking", name: "Opus max", description: null,
      upstreamModelId: "model-1", thinking: true, effort: "max", enabled: true, createdAt: new Date(0) }];
    apps = [{ id: "app-1", name: "chat-app", description: null, enabled: true,
      tiers: [{ name: "max", aliasId: "alias-1" }], createdAt: new Date(0) }];
  }
  test("native Converse and Invoke endpoints resolve and enforce the alias policy", async () => {
    configureAlias();
    for (const endpoint of ["converse", "converse-stream", "invoke", "invoke-stream"] as const) {
      sent = [];
      converseOutput = { body: new TextEncoder().encode('{"usage":{"input_tokens":2,"output_tokens":3}}') };
      const response = await handleBedrockProxy(new Request("https://gateway.test/api/gateway/bedrock/" + endpoint, {
        method: "POST", body: JSON.stringify({ modelId: "chat-app-max", messages: [{ role: "user", content: [{ text: "Hi" }] }],
          additionalModelRequestFields: { thinking: { type: "disabled" }, output_config: { effort: "low" } },
          body: { messages: [{ role: "user", content: "Hi" }], max_tokens: 200, thinking: { type: "disabled" }, output_config: { effort: "low" } } }),
      }), endpoint);
      expect(response.status).toBe(200);
      await response.text();
      expect(sent[0]!.input.modelId).toBe(modelRow!.modelId as string);
      const payload = endpoint.startsWith("invoke")
        ? JSON.parse(new TextDecoder().decode((sent[0]!.input as unknown as { body: Uint8Array }).body))
        : sent[0]!.input.additionalModelRequestFields;
      expect(payload).toMatchObject({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } });
    }
  });
  test("resolves app tiers, pins settings, preserves response ID and bills upstream", async () => {
    configureAlias();
    const response = await call({ model: "chat-app-max", reasoning_effort: "none", thinking: { type: "disabled" }, messages: [{ role: "user", content: "Hi" }] });
    expect(response.status).toBe(200);
    expect((await response.json() as { model: string }).model).toBe("chat-app-max");
    expect(sent[0]!.input).toMatchObject({ modelId: modelRow!.modelId, additionalModelRequestFields: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } } });
    expect(settlements[0]!.modelId).toBe(modelRow!.modelId);
  });
  test("uses the alias policy for playground and streaming responses", async () => {
    configureAlias();
    streamEvents = [{ messageStart: { role: "assistant" } }, { metadata: { usage: { inputTokens: 2, outputTokens: 3 } } }];
    const response = await handleOpenAIProxy(new Request("https://gateway.test/api/playground/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "opus-max-thinking", stream: true, reasoning_effort: "low", messages: [{ role: "user", content: "Hi" }] }),
    }), "session");
    const text = await response.text();
    expect(text).toContain('"model":"opus-max-thinking"');
    expect(sent[0]!.input.modelId).toBe(modelRow!.modelId as string);
    expect(sent[0]!.input.additionalModelRequestFields).toMatchObject({ output_config: { effort: "max" } });
    expect(text).toContain("credit_usage");
  });
  test("does not invoke unavailable or invalid aliases", async () => {
    configureAlias();
    modelRow!.enabled = false;
    expect((await call({ model: "chat-app-max", messages: [{ role: "user", content: "Hi" }] })).status).toBe(400);
    modelRow!.enabled = true;
    aliases[0]!.thinking = false;
    expect((await call({ model: "opus-max-thinking", messages: [{ role: "user", content: "Hi" }] })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
  test("sends images and adaptive effort to Bedrock and returns reasoning", async () => {
    const response = await call({
      model: "global.anthropic.claude-opus-4-7",
      reasoning_effort: "xhigh",
      temperature: 0.7,
      max_completion_tokens: 20000,
      messages: [{ role: "user", content: [
        { type: "text", text: "Describe this image" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      ] }],
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { choices: Array<{ message: Record<string, unknown> }> };
    expect(payload.choices[0]?.message).toEqual({ role: "assistant", content: "A single transparent pixel.", reasoning_content: "Looking at the image." });

    const input = sent[0]!.input;
    expect(input.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" } });
    expect(input.inferenceConfig).toEqual({ maxTokens: 20000 });
    const image = input.messages?.[0]?.content?.[1] as { image: { format: string; source: { bytes: Uint8Array } } };
    expect(image.image.format).toBe("png");
    expect(Buffer.from(image.image.source.bytes).toString("base64")).toBe(PNG_BASE64);
  });

  test("applies the model's default effort when the request omits reasoning_effort", async () => {
    modelRow = model({ modelId: "anthropic.claude-sonnet-4-6", defaultReasoningEffort: "medium" });
    expect((await call({ model: "anthropic.claude-sonnet-4-6", messages: [{ role: "user", content: "Hi" }] })).status).toBe(200);
    expect(sent[0]!.input.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });
    sent = [];
    expect((await call({ model: "anthropic.claude-sonnet-4-6", reasoning_effort: "none", messages: [{ role: "user", content: "Hi" }] })).status).toBe(200);
    expect(sent[0]!.input.additionalModelRequestFields).toBeUndefined();
  });

  test("ignores reasoning_effort for models without reasoning enabled", async () => {
    modelRow = model({ thinking: false, defaultReasoningEffort: "high" });
    expect((await call({ model: "global.anthropic.claude-opus-4-7", reasoning_effort: "high", temperature: 0.3, messages: [{ role: "user", content: "Hi" }] })).status).toBe(200);
    expect(sent[0]!.input.additionalModelRequestFields).toBeUndefined();
    expect(sent[0]!.input.inferenceConfig?.temperature).toBe(0.3);
  });

  test("keeps the historical budget error for small output limits", async () => {
    modelRow = model({ modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0", maxOutputTokens: 8000 });
    const response = await call({ model: "anthropic.claude-sonnet-4-5-20250929-v1:0", reasoning_effort: "high", messages: [{ role: "user", content: "Hi" }] });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "reasoning_budget_exceeds_model_limit", param: "reasoning_effort" });
    expect(sent).toHaveLength(0);
  });

  test("returns OpenAI-style client errors with parameter paths", async () => {
    const invalidEffort = await call({ model: "m", reasoning_effort: "extreme", messages: [{ role: "user", content: "Hi" }] });
    expect(invalidEffort.status).toBe(400);
    expect((await invalidEffort.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "invalid_reasoning_effort", param: "reasoning_effort", type: "invalid_request_error" });

    const badImage = await call({ model: "global.anthropic.claude-opus-4-7", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,bm90IGFuIGltYWdl" } }] }] });
    expect(badImage.status).toBe(400);
    expect((await badImage.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "invalid_image", param: "messages[0].content[0].image_url.url" });

    const privateUrl = await call({ model: "global.anthropic.claude-opus-4-7", messages: [{ role: "user", content: [{ type: "text", text: "?" }, { type: "image_url", image_url: { url: "http://169.254.169.254/latest/meta-data" } }] }] });
    expect(privateUrl.status).toBe(400);
    expect((await privateUrl.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "invalid_image_url", param: "messages[0].content[1].image_url.url" });
    expect(sent).toHaveLength(0);
  });

  test("rejects image URLs when an administrator disabled downloads", async () => {
    remoteImagesEnabled = false;
    const response = await call({ model: "global.anthropic.claude-opus-4-7", messages: [{ role: "user", content: [{ type: "image_url", image_url: "https://example.com/cat.png" }] }] });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: Record<string, unknown> }).error).toMatchObject({ code: "remote_image_urls_disabled", param: "messages[0].content[0].image_url.url" });
  });

  test("streams reasoning_content before answer text", async () => {
    streamEvents = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Thinking it through." } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "Done." } } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 9 } } },
    ];
    const response = await call({ model: "global.anthropic.claude-opus-4-7", stream: true, reasoning_effort: "low", messages: [{ role: "user", content: "Hi" }] });
    expect(response.status).toBe(200);
    const frames = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: ") && frame !== "data: [DONE]")
      .map((frame) => JSON.parse(frame.slice(6)) as { choices: Array<{ delta: Record<string, unknown> }> });
    const deltas = frames.flatMap((frame) => frame.choices.map((choice) => choice.delta));
    expect(deltas).toContainEqual({ reasoning_content: "Thinking it through." });
    expect(deltas.findIndex((delta) => delta.reasoning_content)).toBeLessThan(deltas.findIndex((delta) => delta.content === "Done."));
    expect(sent[0]).toMatchObject({ streaming: true, input: { additionalModelRequestFields: { output_config: { effort: "low" } } } });
  });
});
