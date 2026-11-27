import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ConverseStreamCommand, InvokeModelWithResponseStreamCommand, type ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import type { CapturedReasoning, ReplayEntry } from "./transform/reasoning-replay";

// The handler's persistence, authentication, billing, settings, and AWS client
// dependencies are replaced so the full request pipeline runs in memory.
import { resolveModelCatalog, type ModelCatalog, type RoutingAlias, type RoutingApp } from "../model-routing";
type ModelRow = Record<string, unknown>;
let modelRow: ModelRow | null = null;
let aliases: RoutingAlias[] = [];
let apps: RoutingApp[] = [];
let settlements: Record<string, unknown>[] = [];
let remoteImagesEnabled = true;
let settlementFails = false;
let charged = 0.01;
let settlementGate: Promise<void> | undefined;
let admission: { ok: true } | { ok: false; code: string; message: string } = { ok: true };
let sent: Array<{ streaming: boolean; input: ConverseCommandInput }> = [];
let converseOutput: unknown;
let streamEvents: unknown[] = [];
let userId = "user-1234567890";
/** Bedrock rejects a request (when sent, or as the stream's first event) if this returns an error. */
let rejectRequest: ((input: ConverseCommandInput) => Error | undefined) | undefined;
let rejectInStream = false;
/** Thrown by the stream after its events, as a broken connection or an upstream exception event is. */
let streamFailure: unknown;

// In-memory reasoning replay store with the same user/model scoping as the database.
type ReplayRow = ReplayEntry & { userId: string; modelId: string; requestId: string };
let replayEnabled = true;
let replayRows: ReplayRow[] = [];
let replayStoreFails = false;
let replaySaveGate: Promise<void> | undefined;

mock.module("../model-catalog", () => ({
  listAvailableModels: async () => resolveModelCatalog({ models: modelRow ? [modelRow] : [], aliases, apps } as ModelCatalog),
  resolveModel: async (id: string) => resolveModelCatalog({ models: modelRow ? [modelRow] : [], aliases, apps } as ModelCatalog).find((entry) => entry.modelId === id),
}));
mock.module("../proxy-auth", () => {
  const principal = () => ({ userId, credentialType: "api_key", credentialId: "key-1", scopes: new Set(["ai.invoke"]) });
  return {
    authenticateApiKeyPrincipal: async () => ({ ok: true, principal: principal() }),
    authenticateSessionPrincipal: async () => ({ ok: true, principal: { ...principal(), credentialType: "session" } }),
    requireProxyScope: (result: unknown) => result,
  };
});
mock.module("../credit-service", () => ({
  checkBalance: async () => 100,
  checkCreditAdmission: async () => admission,
  calculateCostBreakdown: () => ({ total: 0.01, inputCost: 0.001, outputCost: 0.002, cacheReadCost: 0.003, cacheWrite5mCost: 0.0015, cacheWrite1hCost: 0.0025 }),
  deductCredits: async (input: Record<string, unknown>) => {
    settlements.push(input);
    await settlementGate;
    if (settlementFails) throw new Error("test settlement failure");
    return { actualCost: 0.01, creditsCharged: charged, balanceAfter: 100 - charged, partiallyCharged: charged < 0.01 };
  },
}));
mock.module("../config-service", () => ({
  getRemoteImageUrlsEnabled: async () => remoteImagesEnabled,
  getReasoningReplayEnabled: async () => replayEnabled,
}));
mock.module("../reasoning-replay-store", () => ({
  loadReplayEntries: async (params: { userId: string; modelId: string; keys: readonly string[] }) => {
    if (replayStoreFails) throw new Error("database unavailable");
    return replayRows.filter((row) => row.userId === params.userId && row.modelId === params.modelId && params.keys.includes(row.lookupKey));
  },
  saveReplayEntry: async (entry: { userId: string; modelId: string; requestId: string; prefixHash: string; predecessorId: string | null; reasoning: CapturedReasoning }) => {
    await replaySaveGate;
    if (replayStoreFails) throw new Error("database unavailable");
    const id = crypto.randomUUID();
    replayRows = replayRows.filter((row) => !(row.userId === entry.userId && row.modelId === entry.modelId && row.lookupKey === entry.reasoning.lookupKey));
    replayRows.push({ id, userId: entry.userId, modelId: entry.modelId, requestId: entry.requestId, prefixHash: entry.prefixHash, predecessorId: entry.predecessorId, ...entry.reasoning });
    return id;
  },
  refreshReplayEntries: async () => {},
}));
mock.module("../bedrock", () => ({
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
  getBedrockClient: async () => ({
    send: async (command: { input: ConverseCommandInput }) => {
      const streaming = command instanceof ConverseStreamCommand;
      sent.push({ streaming, input: command.input });
      if (command instanceof InvokeModelWithResponseStreamCommand) return { body: (async function* () { yield { chunk: { bytes: new TextEncoder().encode('{"type":"message_stop"}') } }; })() };
      const rejection = rejectRequest?.(command.input);
      if (rejection && !(streaming && rejectInStream)) throw rejection;
      if (!streaming) return converseOutput;
      const events = streamEvents;
      const failure = streamFailure;
      return { stream: (async function* () {
        if (rejection) throw rejection;
        for (const event of events) yield event;
        if (failure !== undefined) throw failure;
      })() };
    },
  }),
}));

const { handleOpenAIProxy } = await import("./handler");
const { handleBedrockProxy } = await import("../bedrock-proxy");
const { UPSTREAM_UNAVAILABLE_MESSAGE } = await import("../upstream-errors");

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
  // A complete stream: only messageStop completes a response.
  streamEvents = [{ messageStart: { role: "assistant" } }, { messageStop: { stopReason: "end_turn" } }];
  streamFailure = undefined;
  settlements = [];
  settlementFails = false;
  charged = 0.01;
  settlementGate = undefined;
  admission = { ok: true };
  userId = "user-1234567890";
  rejectRequest = undefined;
  rejectInStream = false;
  replayEnabled = true;
  replayRows = [];
  replayStoreFails = false;
  replaySaveGate = undefined;
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
  for (const code of ["insufficient_credits", "monthly_spend_limit_reached"] as const) {
    test(`refuses with 402 ${code} before calling Bedrock`, async () => {
      const message = code === "insufficient_credits" ? "Insufficient credit balance" : "Monthly spend limit of $300.00 reached; it resets on 2026-12-01 (UTC)";
      admission = { ok: false, code, message };
      const response = await call({ model: "global.anthropic.claude-opus-4-7", messages: [{ role: "user", content: "Hi" }] });
      expect(response.status).toBe(402);
      expect((await response.json()).error).toEqual({ message, type: "invalid_request_error", code });
      const native = await handleBedrockProxy(new Request("https://gateway.test/api/gateway/bedrock/converse", {
        method: "POST", body: JSON.stringify({ modelId: "global.anthropic.claude-opus-4-7", messages: [{ role: "user", content: [{ text: "Hi" }] }] }),
      }), "converse");
      expect(native.status).toBe(402);
      expect(await native.json()).toEqual({ error: { message, code } });
      expect(sent).toHaveLength(0);
      expect(settlements).toHaveLength(0);
    });
  }
  test("stream accounting waits for ledger completion and precedes DONE", async () => {
    let release!: () => void;
    settlementGate = new Promise<void>(resolve => { release = resolve; });
    streamEvents = [{ messageStop: { stopReason: "end_turn" } }, { metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } }];
    const response = await call({ model: "global.anthropic.claude-opus-4-7", stream: true, messages: [{ role: "user", content: "Hi" }] });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let before = "";
    try {
      while (!before.includes('"usage"')) before += decoder.decode((await reader.read()).value);
      expect(before).not.toContain('"cost"');
      expect(before).not.toContain("[DONE]");
    } finally { release(); }
    let after = "";
    while (true) { const part = await reader.read(); if (part.done) break; after += decoder.decode(part.value); }
    expect(after).toContain('"cost":0.01');
    expect(after.indexOf('"cost":0.01')).toBeLessThan(after.indexOf("[DONE]"));
  });
  test("stream TTL details and fallback buckets exactly match billed tokens", async () => {
    for (const cacheDetails of [undefined, [{ ttl: "5m", inputTokens: 7 }, { ttl: "1h", inputTokens: 5 }]]) {
      settlements = [];
      streamEvents = [{ messageStop: { stopReason: "end_turn" } }, { metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5,
        cacheReadInputTokens: 10, cacheWriteInputTokens: 12, cacheDetails } } }];
      const response = await call({ model: "global.anthropic.claude-opus-4-7", stream: true, messages: [{ role: "user", content: "Hi" }] });
      const frames = (await response.text()).split("\n\n").filter(f => f.startsWith("data: {")).map(f => JSON.parse(f.slice(6)));
      const details = frames.filter(f => f.usage).at(-1).usage.prompt_tokens_details;
      expect(details.cached_tokens).toBe(settlements[0]!.cacheReadTokens);
      expect(details.cache_write_5m_tokens).toBe(settlements[0]!.cacheWrite5mTokens);
      expect(details.cache_write_1h_tokens).toBe(settlements[0]!.cacheWrite1hTokens);
      expect(details.cache_write_5m_tokens).toBe(cacheDetails ? 7 : 12);
      expect(details.cache_write_1h_tokens).toBe(cacheDetails ? 5 : 0);
    }
  });
  for (const stream of [false, true]) for (const auth of ["api_key", "session"] as const) {
    for (const state of ["full", "partial", "zero", "failed", "unavailable"] as const) {
      test(`authoritative cost ${state} (${auth}, stream=${stream})`, async () => {
        settlementFails = state === "failed";
        charged = state === "zero" ? 0 : state === "partial" ? 0.003 : 0.01;
        const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadInputTokens: 10,
          cacheWriteInputTokens: 12, cacheDetails: [{ ttl: "5m", inputTokens: 8 }, { ttl: "1h", inputTokens: 4 }] };
        converseOutput = { output: { message: { role: "assistant", content: [{ text: "Done" }] } },
          ...(state === "unavailable" ? {} : { usage }) };
        streamEvents = [{ messageStop: { stopReason: "end_turn" } },
          ...(state === "unavailable" ? [] : [{ metadata: { usage } }])];
        const response = await handleOpenAIProxy(new Request("https://gateway.test/v1/chat/completions", {
          method: "POST", headers: { "content-type": "application/json", "x-request-id": "request-cost-test" },
          body: JSON.stringify({ model: "global.anthropic.claude-opus-4-7", stream, messages: [{ role: "user", content: "Hi" }] }),
        }), auth);
        if (auth === "session" && state === "failed") {
          if (stream) {
            expect(response.status).toBe(200);
            await expect(response.text()).rejects.toThrow("playground credits could not be settled");
          } else {
            expect(response.status).toBe(500);
            expect((await response.json()).error).toBeDefined();
          }
          expect(settlements).toHaveLength(1);
          return;
        }
        expect(response.status).toBe(200);
        let result;
        if (stream) {
          const text = await response.text();
          expect(text.trim().endsWith("data: [DONE]")).toBe(true);
          const frames = text.split("\n\n").filter(f => f.startsWith("data: {")).map(f => JSON.parse(f.slice(6)));
          const usages = frames.filter(f => f.usage);
          result = usages.at(-1);
          if (state !== "unavailable") {
            expect(usages).toHaveLength(2);
            expect(usages[0].usage.cost).toBeUndefined();
            expect(usages[0].id).toBe(result.id);
          }
        } else result = await response.json();
        expect(result.id).toBe("request-cost-test");
        const settled = state !== "failed" && state !== "unavailable";
        expect(result.usage.cost_details.status).toBe(settled ? "settled" : state);
        expect(result.usage.cost_details.currency).toBe("USD");
        expect(result.usage.cost).toBe(settled ? charged : undefined);
        expect(settlements).toHaveLength(state === "unavailable" ? 0 : 1);
        if (settled) {
          expect(result.usage.cost_details).toEqual({ currency: "USD", status: "settled", calculated_cost: 0.01,
            input_cost: 0.001, output_cost: 0.002, cache_read_cost: 0.003, cache_write_5m_cost: 0.0015,
            cache_write_1h_cost: 0.0025, partially_charged: charged < 0.01 });
          expect(result.usage.prompt_tokens).toBe(24);
          expect(result.usage.prompt_tokens_details).toEqual({ cached_tokens: 10, cache_creation_tokens: 12,
            cache_write_tokens: 12, cache_write_5m_tokens: 8, cache_write_1h_tokens: 4 });
          expect(result.credit_usage?.credits_charged).toBe(auth === "session" ? charged : undefined);
        } else {
          expect(result.usage.cost_details).toEqual({ currency: "USD", status: state });
          expect(result.credit_usage).toBeUndefined();
        }
      });
    }
  }
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
    streamEvents = [{ messageStart: { role: "assistant" } }, { messageStop: { stopReason: "end_turn" } }, { metadata: { usage: { inputTokens: 2, outputTokens: 3 } } }];
    const response = await handleOpenAIProxy(new Request("https://gateway.test/api/playground/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "opus-max-thinking", stream: true, reasoning_effort: "low", messages: [{ role: "user", content: "Hi" }] }),
    }), "session");
    const text = await response.text();
    expect(text).toContain('"model":"opus-max-thinking"');
    expect(sent[0]!.input.modelId).toBe(modelRow!.modelId as string);
    expect(sent[0]!.input.additionalModelRequestFields).toMatchObject({ output_config: { effort: "max" } });
    expect(text).toContain("credit_usage");
  });
  for (const stream of [false, true]) {
    for (const publicId of ["opus-max-thinking", "chat-app-max"]) {
      test(`client alias respects OpenAI reasoning_effort (${publicId}, stream=${stream})`, async () => {
        configureAlias();
        aliases[0]!.reasoningSource = "client";
        modelRow = model({ modelId: "anthropic.claude-opus-5", defaultReasoningEffort: "high" });
        streamEvents = [{ messageStart: { role: "assistant" } }, { messageStop: { stopReason: "end_turn" } }, { metadata: { usage: { inputTokens: 2, outputTokens: 3 } } }];
        for (const effort of ["low", "none", undefined]) {
          sent = [];
          const response = await call({ model: publicId, stream, reasoning_effort: effort, messages: [{ role: "user", content: "Hi" }] });
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).toContain(`"model":"${publicId}"`);
          expect(sent[0]!.input.modelId).toBe(modelRow!.modelId as string);
          expect(sent[0]!.input.additionalModelRequestFields).toEqual(effort === "none"
            ? { thinking: { type: "disabled" } }
            : { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: effort ?? "high" } });
          expect(settlements.at(-1)!.modelId).toBe(modelRow!.modelId);
        }
      });
    }
  }
  test("client alias leaves provider defaults alone when no request or upstream default is set", async () => {
    configureAlias();
    aliases[0]!.reasoningSource = "client";
    aliases[0]!.thinking = false;
    aliases[0]!.effort = null;
    const response = await call({ model: "opus-max-thinking", temperature: 0.3, messages: [{ role: "user", content: "Hi" }] });
    expect(response.status).toBe(200);
    expect(sent[0]!.input.additionalModelRequestFields).toBeUndefined();
    expect(sent[0]!.input.inferenceConfig?.temperature).toBe(0.3);
  });
  test("client aliases retain request validation and model output limits", async () => {
    configureAlias();
    aliases[0]!.reasoningSource = "client";
    for (const options of [{ reasoning_effort: "extreme" }, { max_tokens: 64001 }, { max_output_tokens: 64001 }]) {
      expect((await call({ model: "opus-max-thinking", ...options, messages: [{ role: "user", content: "Hi" }] })).status).toBe(400);
    }
    expect(sent).toHaveLength(0);
  });
  test("client alias respects reasoning capability and budget validation just like a direct model", async () => {
    configureAlias();
    aliases[0]!.reasoningSource = "client";
    modelRow = model({ thinking: false });
    expect((await call({ model: "opus-max-thinking", reasoning_effort: "low", messages: [{ role: "user", content: "Hi" }] })).status).toBe(200);
    expect(sent[0]!.input.additionalModelRequestFields).toBeUndefined();
    sent = [];
    modelRow = model({ modelId: "anthropic.claude-sonnet-4-5", maxOutputTokens: 8000 });
    expect((await call({ model: "opus-max-thinking", reasoning_effort: "high", messages: [{ role: "user", content: "Hi" }] })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
  test("client alias playground requests respect the requested effort", async () => {
    configureAlias();
    aliases[0]!.reasoningSource = "client";
    const response = await handleOpenAIProxy(new Request("https://gateway.test/api/playground/chat/completions", {
      method: "POST", body: JSON.stringify({ model: "chat-app-max", stream: true, reasoning_effort: "low", messages: [{ role: "user", content: "Hi" }] }),
    }), "session");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"model":"chat-app-max"');
    expect(sent[0]!.input.additionalModelRequestFields).toMatchObject({ output_config: { effort: "low" } });
  });
  test("client aliases preserve native request options on all Bedrock endpoints, including non-Anthropic Invoke", async () => {
    configureAlias();
    aliases[0]!.reasoningSource = "client";
    modelRow = model({ modelId: "openai.gpt-oss-120b-1:0" });
    for (const endpoint of ["converse", "converse-stream", "invoke", "invoke-stream"] as const) {
      sent = [];
      converseOutput = { body: new TextEncoder().encode('{"usage":{"input_tokens":2,"output_tokens":3}}') };
      const response = await handleBedrockProxy(new Request("https://gateway.test/api/gateway/bedrock/" + endpoint, {
        method: "POST", body: JSON.stringify({ modelId: "chat-app-max", messages: [{ role: "user", content: [{ text: "Hi" }] }],
          additionalModelRequestFields: { reasoning_effort: "low" },
          body: { messages: [{ role: "user", content: "Hi" }], max_tokens: 200, reasoning_effort: "low" } }),
      }), endpoint);
      expect(response.status).toBe(200);
      await response.text();
      expect(sent[0]!.input.modelId).toBe(modelRow!.modelId as string);
      const payload = endpoint.startsWith("invoke")
        ? JSON.parse(new TextDecoder().decode((sent[0]!.input as unknown as { body: Uint8Array }).body))
        : sent[0]!.input.additionalModelRequestFields;
      expect(payload).toMatchObject({ reasoning_effort: "low" });
      if (endpoint.startsWith("invoke")) expect(payload.max_tokens).toBe(200);
    }
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
  for (const stream of [false, true]) {
    for (const route of ["direct", "client-alias", "pinned-alias", "app-tier"] as const) {
      test(`forwards max_output_tokens to Bedrock (${route}, stream=${stream})`, async () => {
        configureAlias();
        if (route === "client-alias") aliases[0]!.reasoningSource = "client";
        const modelId = route === "direct" ? modelRow!.modelId
          : route === "app-tier" ? "chat-app-max" : "opus-max-thinking";
        const response = await call({ model: modelId, stream, max_output_tokens: 1234, messages: [{ role: "user", content: "Hi" }] });
        expect(response.status).toBe(200);
        await response.text();
        expect(sent).toHaveLength(1);
        expect(sent[0]!.streaming).toBe(stream);
        expect(sent[0]!.input.inferenceConfig?.maxTokens).toBe(1234);
        expect(sent[0]!.input).not.toHaveProperty("max_output_tokens");
      });
    }
    test(`validates max_output_tokens before calling Bedrock (stream=${stream})`, async () => {
      for (const limit of [0, -1, 1.5, "1234", 64001]) {
        const response = await call({ model: modelRow!.modelId, stream, max_output_tokens: limit, messages: [{ role: "user", content: "Hi" }] });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("invalid_max_tokens");
      }
      expect(sent).toHaveLength(0);
    });
    test(`retains the configured default when max_output_tokens is null (stream=${stream})`, async () => {
      const response = await call({ model: modelRow!.modelId, stream, max_output_tokens: null, messages: [{ role: "user", content: "Hi" }] });
      expect(response.status).toBe(200);
      await response.text();
      expect(sent[0]!.input.inferenceConfig?.maxTokens).toBe(64000);
    });
  }

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

describe("reasoning replay through the OpenAI-compatible handler", () => {
  const OPUS_55 = "eu.anthropic.claude-opus-5-5";
  const BINDING_BETA = "thinking-binding-controls-2026-08-01";
  const TOOLS = [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  const QUESTION = { role: "user", content: "What is the weather in Stockholm?" };
  const signatureBlock = (signature: string) => ({ reasoningContent: { reasoningText: { text: `Thinking ${signature}.`, signature } } });

  /** One tool step: what Bedrock returns, and what the client sends back afterwards. */
  function toolStep(toolUseId: string, signature: string) {
    const usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    return {
      events: [
        { messageStart: { role: "assistant" } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: `Thinking ${signature}.` } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature } } } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "Checking." } } },
        { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId, name: "weather" } } } },
        { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: "{\"city\":\"Stockholm\"}" } } } },
        { messageStop: { stopReason: "tool_use" } },
        { metadata: { usage } },
      ],
      output: {
        output: { message: { role: "assistant", content: [signatureBlock(signature), { text: "Checking." }, { toolUse: { toolUseId, name: "weather", input: { city: "Stockholm" } } }] } },
        stopReason: "tool_use",
        usage,
      },
      history: [
        { role: "assistant", content: "Checking.", tool_calls: [{ id: toolUseId, type: "function", function: { name: "weather", arguments: "{\"city\":\"Stockholm\"}" } }] },
        { role: "tool", tool_call_id: toolUseId, content: "{\"temperature\":18}" },
      ],
    };
  }

  async function run(stepResponse: ReturnType<typeof toolStep>, body: Record<string, unknown>) {
    streamEvents = stepResponse.events;
    converseOutput = stepResponse.output;
    const response = await call({ reasoning_effort: "max", tools: TOOLS, ...body });
    const text = await response.text();
    expect(response.status).toBe(200);
    return text;
  }
  const reasoningIn = (input: ConverseCommandInput) => (input.messages ?? []).flatMap((message) => (message.content ?? []).filter((block) => block.reasoningContent));
  const rejection = (message: string) => Object.assign(new Error(message), { name: "ValidationException" });

  beforeEach(() => { modelRow = model({ modelId: OPUS_55 }); });

  for (const stream of [false, true]) {
    test(`stores Claude's reasoning and sends it back unmodified in the next tool step (stream=${stream})`, async () => {
      const step1 = toolStep("tooluse_1", "sig-1");
      await run(step1, { model: OPUS_55, stream, messages: [QUESTION] });
      expect(sent[0]!.input.additionalModelRequestFields).toEqual({
        thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort: "max" },
        anthropic_beta: [BINDING_BETA],
      });
      expect(sent[0]!.input.additionalModelResponseFieldPaths).toEqual(["/input_transformations"]);
      expect(replayRows).toHaveLength(1);
      expect(replayRows[0]).toMatchObject({ userId, modelId: OPUS_55, lookupKey: "tool:tooluse_1", predecessorId: null });

      const step2 = toolStep("tooluse_2", "sig-2");
      await run(step2, { model: OPUS_55, stream, messages: [QUESTION, ...step1.history] });
      expect(sent).toHaveLength(2);
      expect(sent[1]!.input.messages![1]!.content).toEqual([
        signatureBlock("sig-1"),
        { text: "Checking." },
        { toolUse: { toolUseId: "tooluse_1", name: "weather", input: { city: "Stockholm" } } },
      ]);
      expect(replayRows[1]).toMatchObject({ lookupKey: "tool:tooluse_2", predecessorId: replayRows[0]!.id });

      await run(toolStep("tooluse_3", "sig-3"), { model: OPUS_55, stream, messages: [QUESTION, ...step1.history, ...step2.history] });
      expect(reasoningIn(sent[2]!.input)).toEqual([signatureBlock("sig-1"), signatureBlock("sig-2")]);
    });
  }

  test("sends reasoning back only to the same user and upstream model", async () => {
    const step1 = toolStep("tooluse_1", "sig-1");
    await run(step1, { model: OPUS_55, messages: [QUESTION] });
    userId = "user-other";
    await run(toolStep("tooluse_2", "sig-2"), { model: OPUS_55, messages: [QUESTION, ...step1.history] });
    expect(reasoningIn(sent[1]!.input)).toEqual([]);
    userId = "user-1234567890";
    modelRow = model({ modelId: "eu.anthropic.claude-sonnet-5-5" });
    await run(toolStep("tooluse_3", "sig-3"), { model: "eu.anthropic.claude-sonnet-5-5", messages: [QUESTION, ...step1.history] });
    expect(reasoningIn(sent[2]!.input)).toEqual([]);
  });

  for (const [stream, where] of [[false, "send"], [true, "send"], [true, "stream"]] as const) {
    test(`retries once without replayed reasoning when Bedrock rejects it (stream=${stream}, ${where})`, async () => {
      const step1 = toolStep("tooluse_1", "sig-1");
      await run(step1, { model: OPUS_55, stream, messages: [QUESTION] });
      rejectRequest = (input) => reasoningIn(input).length > 0 ? rejection("messages.1.content.0: Invalid `signature` in `thinking` block") : undefined;
      rejectInStream = where === "stream";
      const text = await run(toolStep("tooluse_2", "sig-2"), { model: OPUS_55, stream, messages: [QUESTION, ...step1.history] });
      expect(text).toContain("Checking.");
      if (stream) expect(text.trim().endsWith("data: [DONE]")).toBe(true);
      expect(sent).toHaveLength(3);
      expect(reasoningIn(sent[1]!.input)).toHaveLength(1);
      // The retry is the request without anything replay added.
      expect(reasoningIn(sent[2]!.input)).toEqual([]);
      expect(sent[2]!.input.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } });
      // Reasoning produced without the earlier blocks starts a new chain.
      expect(replayRows.find((row) => row.lookupKey === "tool:tooluse_2")?.predecessorId).toBeNull();
      expect(settlements).toHaveLength(2);
    });
  }

  test("leaves out the binding controls for a while after a model rejects them", async () => {
    const HAIKU_55 = "eu.anthropic.claude-haiku-5-5";
    modelRow = model({ modelId: HAIKU_55 });
    rejectRequest = (input) => JSON.stringify(input.additionalModelRequestFields).includes("block_binding")
      ? rejection("thinking.adaptive.block_binding: Extra inputs are not permitted") : undefined;
    await run(toolStep("tooluse_1", "sig-1"), { model: HAIKU_55, messages: [QUESTION] });
    expect(sent).toHaveLength(2);
    await run(toolStep("tooluse_2", "sig-2"), { model: HAIKU_55, messages: [QUESTION] });
    expect(sent).toHaveLength(3);
    expect(sent[2]!.input.additionalModelRequestFields).not.toHaveProperty("anthropic_beta");
  });

  test("budget-thinking Claude models replay without binding controls", async () => {
    const SONNET_45 = "anthropic.claude-sonnet-4-5-20250929-v1:0";
    modelRow = model({ modelId: SONNET_45 });
    const step1 = toolStep("tooluse_1", "sig-1");
    await run(step1, { model: SONNET_45, reasoning_effort: "low", messages: [QUESTION] });
    await run(toolStep("tooluse_2", "sig-2"), { model: SONNET_45, reasoning_effort: "low", messages: [QUESTION, ...step1.history] });
    expect(sent[1]!.input.additionalModelRequestFields).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(reasoningIn(sent[1]!.input)).toEqual([signatureBlock("sig-1")]);
  });

  test("takes no part when replay is turned off or thinking is off", async () => {
    replayEnabled = false;
    const step1 = toolStep("tooluse_1", "sig-1");
    await run(step1, { model: OPUS_55, messages: [QUESTION] });
    expect(sent[0]!.input.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" } });
    expect(replayRows).toEqual([]);

    replayEnabled = true;
    modelRow = model({ modelId: "anthropic.claude-opus-5" });
    await run(step1, { model: "anthropic.claude-opus-5", reasoning_effort: "none", messages: [QUESTION] });
    expect(sent[1]!.input.additionalModelRequestFields).toEqual({ thinking: { type: "disabled" } });
    expect(replayRows).toEqual([]);
  });

  for (const stream of [false, true]) {
    test(`a failing store never fails the request (stream=${stream})`, async () => {
      replayStoreFails = true;
      const step1 = toolStep("tooluse_1", "sig-1");
      await run(step1, { model: OPUS_55, stream, messages: [QUESTION] });
      await run(toolStep("tooluse_2", "sig-2"), { model: OPUS_55, stream, messages: [QUESTION, ...step1.history] });
      expect(reasoningIn(sent[1]!.input)).toEqual([]);
      expect(settlements).toHaveLength(2);
    });
  }

  test("a stream ends only after its reasoning is stored", async () => {
    let release!: () => void;
    replaySaveGate = new Promise<void>((resolve) => { release = resolve; });
    streamEvents = toolStep("tooluse_1", "sig-1").events;
    const response = await call({ model: OPUS_55, stream: true, reasoning_effort: "max", tools: TOOLS, messages: [QUESTION] });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let before = "";
    try {
      while (!before.includes("\"cost\"")) before += decoder.decode((await reader.read()).value);
      expect(before).not.toContain("[DONE]");
      expect(replayRows).toHaveLength(0);
    } finally { release(); }
    let after = "";
    while (true) { const part = await reader.read(); if (part.done) break; after += decoder.decode(part.value); }
    expect(after).toContain("[DONE]");
    expect(replayRows).toHaveLength(1);
  });
});

describe("lost upstream connections", () => {
  const MODEL = "global.anthropic.claude-opus-4-7";
  const ADDRESS = "10.103.57.41:8080";
  const levels = ["error", "warn", "info", "log"] as const;
  let logs: Record<(typeof levels)[number], string[]>;
  let spies: Array<{ mockRestore(): void }> = [];
  beforeEach(() => {
    logs = { error: [], warn: [], info: [], log: [] };
    spies = levels.map((level) => spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs[level].push(args.map(String).join(" "));
    }));
  });
  afterEach(() => { for (const spy of spies) spy.mockRestore(); });

  /** What the AWS SDK throws, after its retries, when the upstream refuses the connection. */
  const refused = () => Object.assign(new Error(`The pending stream has been canceled (caused by: connect ECONNREFUSED ${ADDRESS})`), {
    code: "ERR_HTTP2_STREAM_CANCEL",
    cause: Object.assign(new Error(`connect ECONNREFUSED ${ADDRESS}`), { code: "ECONNREFUSED", syscall: "connect", address: "10.103.57.41", port: 8080 }),
    $metadata: { attempts: 3, totalRetryDelay: 184 },
  });
  const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  /** The SDK appends this to errors it raises while reading a response, and records the response's status. */
  const HINT = "\n  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.";
  const whileReading = <T extends Error>(error: T) => Object.assign(error, { message: error.message + HINT, $metadata: { httpStatusCode: 200, attempts: 1, totalRetryDelay: 0 } });

  function request(body: Record<string, unknown>, requestId: string, auth: "api_key" | "session" = "api_key") {
    return handleOpenAIProxy(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Hi" }], ...body }),
    }), auth);
  }

  /** A stream's parsed data events, and whether it ended with [DONE]. */
  async function read(response: Response) {
    const frames = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "));
    return {
      done: frames.at(-1) === "data: [DONE]",
      data: frames.filter((frame) => frame !== "data: [DONE]").map((frame) => JSON.parse(frame.slice(6))),
    };
  }
  const choices = (data: Array<{ choices?: Array<{ delta: { content?: string }; finish_reason: string | null }> }>) =>
    data.flatMap((chunk) => chunk.choices ?? []);

  const partial = [
    { messageStart: { role: "assistant" } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "The quick " } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "brown " } } },
  ];
  const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 18 };
  const interrupted = {
    message: "The upstream model provider's stream ended before the response was complete",
    type: "server_error",
    code: "stream_interrupted",
    param: null,
  };

  for (const stream of [false, true]) {
    test(`a refused connection is 503 service_unavailable without the upstream's address (stream=${stream})`, async () => {
      rejectRequest = () => refused();
      const response = await request({ stream }, "request-refused");
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toEqual({ error: { message: UPSTREAM_UNAVAILABLE_MESSAGE, type: "server_error", code: "service_unavailable" } });
      expect(JSON.stringify(body)).not.toMatch(/10\.103|ECONNREFUSED|cancel/i);
      expect(settlements).toHaveLength(0);
      const line = logs.error.find((entry) => entry.includes("Upstream unavailable"));
      expect(line).toContain(`request=request-refused model=${MODEL} stream=${stream} status=503 code=service_unavailable`);
      // Operators still see what failed, and where.
      expect(line).toContain(`ECONNREFUSED ${ADDRESS}`);
      expect(line).toContain("attempts=3");
    });
  }

  test("reset, timed-out and failed HTTP/2 connections, DNS failures and gateway statuses are 503 too", async () => {
    const failures = [
      reset(),
      Object.assign(new Error(`connect ETIMEDOUT ${ADDRESS}`), { code: "ETIMEDOUT" }),
      Object.assign(new Error("Socket timed out without establishing a connection within 1000 ms"), { name: "TimeoutError" }),
      new Error("HTTP/2 stream is abnormally aborted in mid-communication with result code 2."),
      new Error("Unexpected error: http2 request did not get a response"),
      Object.assign(new Error("getaddrinfo ENOTFOUND shim.internal"), { code: "ENOTFOUND" }),
      Object.assign(new Error("UnknownError"), { name: "UnknownError", $fault: "server", $metadata: { httpStatusCode: 502 } }),
      // A non-streaming response cut off mid-body: the HTTP/2 stream ends cleanly and the JSON is incomplete.
      whileReading(new SyntaxError("JSON Parse error: Expected '}'")),
    ];
    for (const stream of [false, true]) {
      for (const failure of failures) {
        rejectRequest = () => failure;
        const response = await request({ stream }, "request-down");
        expect(response.status).toBe(503);
        expect((await response.json()).error).toEqual({ message: UPSTREAM_UNAVAILABLE_MESSAGE, type: "server_error", code: "service_unavailable" });
      }
    }
    expect(logs.error.filter((entry) => entry.includes("Upstream unavailable: request=request-down"))).toHaveLength(failures.length * 2);
  });

  test("Bedrock's errors keep their status and message; the gateway's own errors keep theirs in the log", async () => {
    const cases: Array<[Error, number, Record<string, unknown>]> = [
      [Object.assign(new Error("Too many requests, please wait before trying again."), { name: "ThrottlingException", $fault: "client", $metadata: { httpStatusCode: 429 } }),
        429, { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Too many requests, please wait before trying again." }],
      [Object.assign(new Error("Bedrock is unable to process your request."), { name: "ServiceUnavailableException", $fault: "server", $metadata: { httpStatusCode: 503 } }),
        503, { type: "server_error", code: "service_unavailable", message: "Bedrock is unable to process your request." }],
      [Object.assign(new Error("The system encountered an unexpected error during processing."), { name: "InternalServerException", $fault: "server", $metadata: { httpStatusCode: 500 } }),
        500, { type: "server_error", code: "internal_error", message: "The system encountered an unexpected error during processing." }],
      // An exception event that opens the stream: the SDK raises it from send() without its type.
      [whileReading(new Error("Too many requests, please wait before trying again.")),
        500, { type: "server_error", code: "internal_error", message: "Too many requests, please wait before trying again." }],
      [new TypeError("Cannot read properties of undefined (reading 'usage')"),
        500, { type: "server_error", code: "internal_error", message: "Internal server error" }],
    ];
    for (const [failure, status, error] of cases) {
      rejectRequest = () => failure;
      const response = await request({}, "request-error");
      expect(response.status).toBe(status);
      expect((await response.json()).error).toEqual(error);
    }
    expect(logs.warn.some((entry) => entry.includes("Upstream error: request=request-error") && entry.includes("ThrottlingException"))).toBe(true);
    expect(logs.error.some((entry) => entry.includes("Request failed: request=request-error") && entry.includes("reading 'usage'"))).toBe(true);
  });

  test("a client that leaves before the upstream answers is not an upstream failure", async () => {
    const client = new AbortController();
    rejectRequest = () => {
      client.abort();
      return Object.assign(new Error("Request aborted"), { name: "AbortError" });
    };
    const response = await handleOpenAIProxy(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-left" },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "Hi" }] }),
      signal: client.signal,
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("request_aborted");
    expect(logs.error).toEqual([]);
    expect(logs.info.some((entry) => entry.includes("Request canceled: request=request-left"))).toBe(true);
  });

  test("a stream that ends before messageStop ends with an error event instead of [DONE]", async () => {
    streamEvents = partial;
    const response = await request({ stream: true }, "request-cut");
    expect(response.status).toBe(200);
    const { data, done } = await read(response);
    expect(done).toBe(false);
    expect(choices(data).map((choice) => choice.delta.content).join("")).toBe("The quick brown ");
    expect(choices(data).every((choice) => choice.finish_reason === null)).toBe(true);
    // No usage chunk makes the cut-off response look finished: the error is the last event.
    expect(data.filter((chunk) => chunk.usage)).toEqual([]);
    expect(data.at(-1)).toEqual({ error: interrupted });
    expect(settlements).toHaveLength(0);
    const line = logs.error.find((entry) => entry.includes("Stream failed"));
    expect(line).toContain(`Stream failed: request=request-cut model=${MODEL} after=`);
    expect(line).toContain("received=messageStart:1,contentBlockDelta:2 usage=none error=the upstream ended the stream before messageStop");
  });

  test("a stream cut inside an event, or by a broken connection, ends with the same error event", async () => {
    for (const failure of [new Error("Truncated event message received."), reset()]) {
      streamEvents = partial;
      streamFailure = failure;
      const { data, done } = await read(await request({ stream: true }, "request-cut"));
      expect(done).toBe(false);
      expect(data.at(-1)).toEqual({ error: interrupted });
    }
    const lines = logs.error.filter((entry) => entry.includes("Stream failed: request=request-cut"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("error=Error: Truncated event message received.");
    expect(lines[1]).toContain("error=Error(ECONNRESET): read ECONNRESET");
  });

  test("usage that arrived before the stream was cut is charged, and settled before the error event", async () => {
    streamEvents = [...partial, { metadata: { usage } }];
    const { data, done } = await read(await request({ stream: true }, "request-cut-billed"));
    expect(done).toBe(false);
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({ requestId: "request-cut-billed", inputTokens: 11, outputTokens: 7 });
    expect(data.at(-2).usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, cost: 0.01, cost_details: { status: "settled" } });
    expect(data.at(-1)).toEqual({ error: interrupted });
    expect(logs.error.find((entry) => entry.includes("Stream failed"))).toContain("usage=reported");
    expect(logs.log.some((entry) => entry.includes("Complete: request=request-cut-billed") && entry.includes("stop=interrupted"))).toBe(true);
  });

  test("an exception the upstream sends mid-stream ends the response with its error", async () => {
    const cases: Array<[unknown, Record<string, unknown>]> = [
      // AWS SDK 3.1003 throws a stream's exception event as the event's bare structure.
      [{ message: "Too many requests, please wait before trying again." },
        { type: "server_error", code: "upstream_error", message: "Too many requests, please wait before trying again." }],
      [Object.assign(new Error("Too many requests, please wait before trying again."), { name: "ThrottlingException", $fault: "client", $metadata: {} }),
        { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Too many requests, please wait before trying again." }],
      [new TypeError("Cannot read properties of undefined (reading 'text')"),
        { type: "server_error", code: "internal_error", message: "The response failed before it was complete" }],
    ];
    for (const [failure, error] of cases) {
      streamEvents = partial;
      streamFailure = failure;
      const { data, done } = await read(await request({ stream: true }, "request-exception"));
      expect(done).toBe(false);
      expect(data.at(-1)).toEqual({ error: { ...error, param: null } });
    }
  });

  test("a failure after messageStop keeps the complete response", async () => {
    streamEvents = [...partial, { messageStop: { stopReason: "end_turn" } }, { metadata: { usage } }];
    streamFailure = reset();
    const { data, done } = await read(await request({ stream: true }, "request-late"));
    expect(done).toBe(true);
    expect(data.some((chunk) => chunk.error)).toBe(false);
    expect(choices(data).at(-1)?.finish_reason).toBe("stop");
    expect(settlements).toHaveLength(1);
    expect(logs.warn.some((entry) => entry.includes("Stream failed after messageStop, response kept: request=request-late"))).toBe(true);
  });

  test("a complete stream without usage still ends with [DONE] and logs its request", async () => {
    const { data, done } = await read(await request({ stream: true }, "request-no-usage"));
    expect(done).toBe(true);
    expect(data.at(-1).usage.cost_details).toEqual({ currency: "USD", status: "unavailable" });
    expect(logs.warn).toContain(`[OpenAI Proxy] Stream completed with no usage metadata: request=request-no-usage model=${MODEL} stop=end_turn`);
  });

  test("the playground gets the same error event", async () => {
    streamEvents = partial;
    const { data, done } = await read(await request({ stream: true }, "request-playground", "session"));
    expect(done).toBe(false);
    expect(data.at(-1)).toEqual({ error: interrupted });
  });

  test("native Bedrock endpoints answer a refused connection with 503 service_unavailable", async () => {
    rejectRequest = () => refused();
    for (const endpoint of ["converse", "converse-stream", "invoke"] as const) {
      const response = await handleBedrockProxy(new Request("https://gateway.test/api/gateway/bedrock/" + endpoint, {
        method: "POST",
        headers: { "x-request-id": "request-native" },
        body: JSON.stringify({ modelId: MODEL, messages: [{ role: "user", content: [{ text: "Hi" }] }], body: { messages: [{ role: "user", content: "Hi" }], max_tokens: 20 } }),
      }), endpoint);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { message: UPSTREAM_UNAVAILABLE_MESSAGE, code: "service_unavailable" } });
    }
    const lines = logs.error.filter((entry) => entry.includes("[Bedrock Proxy] Upstream unavailable: request=request-native"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`ECONNREFUSED ${ADDRESS}`);
  });
});
