import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
let settlementFails = false;
let charged = 0.01;
let settlementGate: Promise<void> | undefined;
let sent: Array<{ streaming: boolean; input: ConverseCommandInput }> = [];
let converseOutput: unknown;
let streamEvents: unknown[] = [];
let sendError: Error | undefined;
let invokeStreamUsage = false;
let principalUserId = "user-1234567890";
let principalCredentialId = "key-1";

// Preserve the real class/validation exports for other suites; replace only the
// handler singleton. The database store module is neither imported nor mocked.
const cacheModule = await import("../conversation-cache");
const receipts = new Map<string, import("../conversation-cache-types").StoredConversationBoundary>();
let cacheReads = 0;
let cacheWrites = 0;
mock.module("../conversation-cache", () => ({
  ...cacheModule,
  conversationCache: new cacheModule.ConversationCache(async () => ({
    async get(key) { cacheReads++; return receipts.get(key); },
    async put(input) {
      cacheWrites++;
      const current = receipts.get(input.key);
      if (input.expectedVersion === null ? current && current.expiresAt > Date.now() : current?.version !== input.expectedVersion) return;
      receipts.set(input.key, { version: crypto.randomUUID(), boundary: input.boundary, expiresAt: input.expiresAt });
    },
  })),
}));

mock.module("../model-catalog", () => ({
  listAvailableModels: async () => resolveModelCatalog({ models: modelRow ? [modelRow] : [], aliases, apps } as ModelCatalog),
  resolveModel: async (id: string) => resolveModelCatalog({ models: modelRow ? [modelRow] : [], aliases, apps } as ModelCatalog).find((entry) => entry.modelId === id),
}));
mock.module("../proxy-auth", () => {
  const principal = { userId: "user-1234567890", credentialType: "api_key", credentialId: "key-1", scopes: new Set(["ai.invoke"]) };
  return {
    authenticateApiKeyPrincipal: async () => ({ ok: true, principal: { ...principal, userId: principalUserId, credentialId: principalCredentialId } }),
    authenticateSessionPrincipal: async () => ({ ok: true, principal: { ...principal, userId: principalUserId, credentialId: principalCredentialId, credentialType: "session" } }),
    requireProxyScope: (result: unknown) => result,
  };
});
mock.module("../credit-service", () => ({
  checkBalance: async () => 100,
  calculateCostBreakdown: () => ({ total: 0.01, inputCost: 0.001, outputCost: 0.002, cacheReadCost: 0.003, cacheWrite5mCost: 0.0015, cacheWrite1hCost: 0.0025 }),
  deductCredits: async (input: Record<string, unknown>) => {
    settlements.push(input);
    await settlementGate;
    if (settlementFails) throw new Error("test settlement failure");
    return { actualCost: 0.01, creditsCharged: charged, balanceAfter: 100 - charged, partiallyCharged: charged < 0.01 };
  },
}));
mock.module("../config-service", () => ({ getRemoteImageUrlsEnabled: async () => remoteImagesEnabled }));
mock.module("../bedrock", () => ({
  ProviderNotConfiguredError: class ProviderNotConfiguredError extends Error {},
  getBedrockClient: async () => ({
    send: async (command: { input: ConverseCommandInput }) => {
      const streaming = command instanceof ConverseStreamCommand;
      sent.push({ streaming, input: command.input });
      if (sendError) throw sendError;
      if (command instanceof InvokeModelWithResponseStreamCommand) return { body: (async function* () {
        if (invokeStreamUsage) yield { chunk: { bytes: new TextEncoder().encode('{"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}') } };
        yield { chunk: { bytes: new TextEncoder().encode('{"type":"message_stop"}') } };
      })() };
      if (!streaming) return converseOutput;
      return { stream: (async function* () { for (const event of streamEvents) yield event; })() };
    },
  }),
}));

const { handleOpenAIProxy } = await import("./handler");
const { handleBedrockProxy } = await import("../bedrock-proxy");

function nativeCall(endpoint: "converse" | "converse-stream" | "invoke" | "invoke-stream", body: unknown, headers: Record<string, string> = {}) {
  return handleBedrockProxy(new Request("https://gateway.test/api/gateway/bedrock/" + endpoint, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }), endpoint);
}

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function model(overrides: ModelRow = {}): ModelRow {
  return {
    id: "model-1", name: "Opus", createdAt: new Date(0), modelId: "global.anthropic.claude-opus-4-7", inputPricePerMTok: 5, outputPricePerMTok: 25,
    cacheReadPricePerMTok: null, cacheWrite5mPricePerMTok: null, cacheWrite1hPricePerMTok: null,
    managedCache: false, region: null, maxOutputTokens: 64000, thinking: true, reasoningMode: "auto",
    defaultReasoningEffort: null, enabled: true, provider: "bedrock", ...overrides,
  };
}

function call(body: unknown, headers: Record<string, string> = {}) {
  return handleOpenAIProxy(new Request("https://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer aig_test", ...headers },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  modelRow = model();
  receipts.clear(); cacheReads = 0; cacheWrites = 0;
  sendError = undefined;
  invokeStreamUsage = false;
  principalUserId = "user-1234567890"; principalCredentialId = "key-1";
  aliases = []; apps = [];
  remoteImagesEnabled = true;
  sent = [];
  streamEvents = [];
  settlements = [];
  settlementFails = false;
  charged = 0.01;
  settlementGate = undefined;
  converseOutput = {
    output: { message: { role: "assistant", content: [
      { reasoningContent: { reasoningText: { text: "Looking at the image.", signature: "sig" } } },
      { text: "A single transparent pixel." },
    ] } },
    stopReason: "end_turn",
    usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50 },
  };
});

describe("unsupported conversation body field", () => {
  function body(stream: boolean, count: number, conversation?: unknown) {
    return {
      model: modelRow!.modelId, stream, conversation,
      messages: [{ role: "system", content: "Stable instructions" }, {
        role: "user", content: Array.from({ length: count }, (_, i) => ({ type: "text", text: `Block ${i}` })),
      }],
      tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: {} } } }],
    };
  }
  for (const stream of [false, true]) {
    test(`rejects non-null conversation before metadata/provider (stream=${stream})`, async () => {
      modelRow = model({ managedCache: true });
      for (const conversation of ["thread", { id: "thread" }, "", 42, false, [], {}]) {
        const response = await call(body(stream, 24, conversation), { "x-conversation-id": "thread" });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toMatchObject({ code: "unsupported_parameter", param: "conversation" });
      }
      expect(sent).toHaveLength(0);
      expect(cacheReads).toBe(0);
      expect(cacheWrites).toBe(0);
    });
    test(`null conversation is ignored (stream=${stream})`, async () => {
      modelRow = model({ managedCache: true });
      const response = await call(body(stream, 24, null));
      expect(response.status).toBe(200);
      expect(response.headers.has("x-conversation-id")).toBe(false);
      await response.text();
      expect(sent[0]!.input).not.toHaveProperty("conversation");
      expect(cacheReads).toBe(0);
      expect(cacheWrites).toBe(0);
    });
  }
});

describe("client request attempt tracing", () => {
  const routes = ["openai", "openai-stream", "session", "session-stream", "converse", "converse-stream", "invoke", "invoke-stream"] as const;
  for (const route of routes) {
    const openai = route.startsWith("openai") || route.startsWith("session");
    const stream = route.endsWith("stream");
    async function attempt(headers: Record<string, string> = {}, count = 24, malformed = false) {
      streamEvents = [{ metadata: { usage: { inputTokens: 2, outputTokens: 3 } } }];
      invokeStreamUsage = true;
      const texts = Array.from({ length: count }, (_, i) => `Block ${i}`);
      let body: unknown;
      if (openai) body = { model: modelRow!.modelId, stream,
        messages: [{ role: "system", content: "Instructions" }, { role: "user", content: texts.map(text => ({ type: "text", text })) }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
      };
      else if (route.startsWith("invoke")) {
        converseOutput = { body: new TextEncoder().encode('{"usage":{"input_tokens":2,"output_tokens":3}}') };
        body = { modelId: modelRow!.modelId, body: { anthropic_version: "bedrock-2023-05-31", max_tokens: 200,
          system: "Instructions", tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
          messages: [{ role: "user", content: texts.map(text => ({ type: "text", text })) }],
        } };
      } else body = { modelId: modelRow!.modelId, system: [{ text: "Instructions" }],
        toolConfig: { tools: [{ toolSpec: { name: "lookup", inputSchema: { json: { type: "object", properties: {} } } } }] },
        messages: [{ role: "user", content: texts.map(text => ({ text })) }],
      };
      const req = new Request("https://gateway.test/trace-test", { method: "POST",
        headers: { "content-type": "application/json", ...headers }, body: malformed ? "{oops" : JSON.stringify(body) });
      return openai ? handleOpenAIProxy(req, route.startsWith("session") ? "session" : "api_key")
        : handleBedrockProxy(req, route as "converse" | "converse-stream" | "invoke" | "invoke-stream");
    }
    test(`${route}: attempts echo separately but preserve explicit billing ID and cache scope`, async () => {
      modelRow = model({ managedCache: true });
      for (const [index, trace] of ["step/1", "step/2"].entries()) {
        const response = await attempt({ "X-Client-Request-Id": trace, "X-Request-ID": "billing-stable", "X-Conversation-ID": "same-thread" }, index ? 50 : 24);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-client-request-id")).toBe(trace);
        if (openai) expect(response.headers.get("x-request-id")).toBe("billing-stable");
        await response.text();
        expect(settlements.at(-1)!.requestId).toBe("billing-stable");
        const raw = sent.at(-1)!.input;
        const payload = route.startsWith("invoke") ? JSON.parse(new TextDecoder().decode((raw as unknown as { body: Uint8Array }).body)) : raw;
        expect(JSON.stringify(payload)).not.toContain(trace);
        expect(JSON.stringify(payload).match(/"(?:cachePoint|cache_control)":/g)).toHaveLength(index ? 4 : 3);
      }
      expect(settlements).toHaveLength(2);
      expect(receipts.size).toBe(1);
    });
    test(`${route}: structured logs retain the attempt identifier`, async () => {
      const info = spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await attempt({ "x-client-request-id": "logged / attempt:1" });
        expect(response.status).toBe(200);
        await response.text();
        const logged = info.mock.calls.flat().flatMap(value => {
          if (typeof value === "object" && value !== null) return [value];
          if (typeof value !== "string") return [];
          try { return [JSON.parse(value)]; } catch { return []; }
        });
        expect(logged).toContainEqual(expect.objectContaining({ clientRequestId: "logged / attempt:1" }));
      } finally { info.mockRestore(); }
    });
    test(`${route}: trace alone never becomes a billing dedup key`, async () => {
      for (const trace of ["step/1", "step/2", "step/1"]) {
        const response = await attempt({ "x-client-request-id": trace });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-client-request-id")).toBe(trace);
        await response.text();
        const id = settlements.at(-1)!.requestId;
        expect(id).not.toBe(trace);
        expect(id).not.toBe("step");
        if (openai) expect(response.headers.get("x-request-id")).toBe(id as string);
      }
      expect(new Set(settlements.map(value => value.requestId)).size).toBe(3);
    });
    test(`${route}: validates printable ASCII and length before provider/store`, async () => {
      modelRow = model({ managedCache: true });
      for (const trace of ["", "x".repeat(513), "caf\u00e9", "bad\u007fid", "bad\u0001id", "bad\tid"]) {
        const response = await attempt({ "x-client-request-id": trace, "x-conversation-id": "validation" });
        expect(response.status).toBe(400);
        const text = await response.text();
        expect(text).toContain("invalid_client_request_id");
        if (openai) expect(JSON.parse(text).error.param).toBe("X-Client-Request-Id");
      }
      expect(sent).toHaveLength(0);
      expect(cacheReads).toBe(0);
      expect(cacheWrites).toBe(0);
      for (const trace of ["x".repeat(512), "attempt / 1: punctuation!? #[]"]) {
        const response = await attempt({ "x-client-request-id": trace });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-client-request-id")).toBe(trace);
        await response.text();
      }
      const absent = await attempt();
      expect(absent.headers.has("x-client-request-id")).toBe(false);
      await absent.text();
    });
    test(`${route}: echoes valid trace on malformed body and mapped provider failures`, async () => {
      const malformed = await attempt({ "x-client-request-id": "parse/1" }, 24, true);
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("x-client-request-id")).toBe("parse/1");
      await malformed.text();
      sendError = Object.assign(new Error("provider rejected"), { name: "ValidationException" });
      const failure = await attempt({ "x-client-request-id": "provider/1" });
      expect(failure.status).toBeGreaterThanOrEqual(400);
      expect(failure.headers.get("x-client-request-id")).toBe("provider/1");
      await failure.text();
    });
  }
});

describe("conversation header request pipeline", () => {
  const routes = ["openai", "openai-stream", "converse", "converse-stream", "invoke", "invoke-stream", "invoke-json", "invoke-stream-json"] as const;
  type Route = typeof routes[number];
  function request(route: Route, count: number, id?: string) {
    const headers: Record<string, string> = id === undefined ? {} : { "x-conversation-id": id };
    const texts = Array.from({ length: count }, (_, i) => `Block ${i}`);
    const schema = { type: "object", properties: {} };
    if (route.startsWith("openai")) return call({
      model: modelRow!.modelId, stream: route.endsWith("stream"),
      messages: [{ role: "system", content: "Stable instructions" },
        { role: "user", content: texts.map(text => ({ type: "text", text })) }],
      tools: [{ type: "function", function: { name: "search", parameters: schema } }],
    }, headers);
    if (route.startsWith("converse")) return nativeCall(route as "converse" | "converse-stream", {
      modelId: modelRow!.modelId, system: [{ text: "Stable instructions" }],
      messages: [{ role: "user", content: texts.map(text => ({ text })) }],
      toolConfig: { tools: [{ toolSpec: { name: "search", inputSchema: { json: schema } } }] },
    }, headers);
    converseOutput = { body: new TextEncoder().encode('{"usage":{"input_tokens":2,"output_tokens":3}}') };
    const body = { anthropic_version: "bedrock-2023-05-31", max_tokens: 200,
      system: "Stable instructions", tools: [{ name: "search", input_schema: schema }],
      messages: [{ role: "user", content: texts.map(text => ({ type: "text", text })) }],
    };
    return nativeCall(route.includes("stream") ? "invoke-stream" : "invoke", {
      modelId: modelRow!.modelId, body: route.endsWith("json") ? JSON.stringify(body) : body,
    }, headers);
  }
  function outbound(route: Route): Record<string, any> {
    const input = sent.at(-1)!.input;
    return route.startsWith("invoke")
      ? JSON.parse(new TextDecoder().decode((input as unknown as { body: Uint8Array }).body)) : input;
  }
  function messageMarkers(route: Route): number[] {
    const content = outbound(route).messages[0].content as Array<Record<string, unknown>>;
    let textIndex = -1;
    return content.flatMap(block => {
      if (block.text !== undefined) textIndex++;
      return block.cachePoint || block.cache_control ? [textIndex] : [];
    });
  }
  for (const route of routes) {
    test(`${route}: restores previous boundary beyond 20 blocks and echoes header`, async () => {
      modelRow = model({ managedCache: true });
      for (const count of [24, 50]) {
        const response = await request(route, count, "chat:stable-1");
        expect(response.status).toBe(200);
        expect(response.headers.get("x-conversation-id")).toBe("chat:stable-1");
        await response.text();
        expect(messageMarkers(route)).toEqual(count === 24 ? [23] : [23, 49]);
        const payload = outbound(route);
        const allMarkers = JSON.stringify(payload).match(/"(?:cachePoint|cache_control)":/g) ?? [];
        expect(allMarkers).toHaveLength(count === 24 ? 3 : 4);
      }
      expect(cacheReads).toBe(2);
      expect(cacheWrites).toBe(2);
      expect(receipts.size).toBe(1);
    });

    test(`${route}: rejects invalid IDs before provider or store access`, async () => {
      modelRow = model({ managedCache: true });
      for (const id of ["", "bad id", "bad/id", "x".repeat(129)]) {
        const response = await request(route, 24, id);
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("invalid_conversation_id");
      }
      expect(sent).toHaveLength(0);
      expect(cacheReads).toBe(0);
      expect(cacheWrites).toBe(0);
    });

    test(`${route}: missing header remains stateless and disabled cache does not track`, async () => {
      modelRow = model({ managedCache: true });
      for (const count of [24, 50]) {
        const response = await request(route, count);
        expect(response.status).toBe(200);
        expect(response.headers.has("x-conversation-id")).toBe(false);
        await response.text();
        expect(messageMarkers(route)).toEqual([count - 1]);
      }
      modelRow = model({ managedCache: false });
      const response = await request(route, 50, "disabled");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-conversation-id")).toBe("disabled");
      await response.text();
      expect(messageMarkers(route)).toEqual([]);
      expect(cacheReads).toBe(0);
      expect(cacheWrites).toBe(0);
    });

    test(`${route}: provider rejection never commits a boundary`, async () => {
      modelRow = model({ managedCache: true });
      sendError = new Error("test provider rejection");
      const failed = await request(route, 24, "provider-failure");
      expect(failed.status).toBeGreaterThanOrEqual(400);
      await failed.text();
      expect(cacheWrites).toBe(0);
      expect(receipts.size).toBe(0);
      sendError = undefined;
      const success = await request(route, 50, "provider-failure");
      expect(success.status).toBe(200);
      await success.text();
      expect(messageMarkers(route)).toEqual([49]);
      expect(cacheWrites).toBe(1);
    });
  }

  for (const scope of ["conversation", "user", "credential", "model", "region", "format"] as const) {
    test(`does not reuse a boundary across ${scope} scope`, async () => {
      modelRow = model({ managedCache: true });
      await (await request("openai", 24, "scope-a")).text();
      let route: Route = "openai";
      let id = "scope-a";
      if (scope === "conversation") id = "scope-b";
      if (scope === "user") principalUserId = "another-user";
      if (scope === "credential") principalCredentialId = "another-key";
      if (scope === "model") modelRow.id = "another-model-row";
      if (scope === "region") modelRow.region = "eu-west-1";
      if (scope === "format") route = "invoke-json";
      const response = await request(route, 50, id);
      expect(response.status).toBe(200);
      await response.text();
      expect(messageMarkers(route)).toEqual([49]);
      expect(receipts.size).toBe(2);
    });
  }
});

describe("managed prompt cache request pipeline", () => {
  const longCachePoint = { cachePoint: { type: "default", ttl: "1h" } } as const;
  const shortCachePoint = { cachePoint: { type: "default", ttl: "5m" } } as const;
  const cacheControl = { cache_control: { type: "ephemeral" } };
  const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
  const functions = ["search", "lookup"].map(name => ({ name, description: `${name} records`, parameters: schema }));
  const tools = functions.map(({ parameters, ...spec }) => ({ toolSpec: { ...spec, inputSchema: { json: parameters } } }));
  const system = [{ text: "System instructions" }, { text: "Developer instructions" }];
  const messages = [
    { role: "user" as const, content: [{ text: "Earlier question" }] },
    { role: "assistant" as const, content: [{ text: "Earlier answer" }] },
    { role: "user" as const, content: [{ text: "Context" }, { text: "Final question" }] },
  ];

  for (const stream of [false, true]) for (const managedCache of [false, true]) {
    test(`OpenAI system, developer and tools caching (stream=${stream}, managedCache=${managedCache})`, async () => {
      modelRow = model({ managedCache, thinking: false });
      const response = await call({
        model: modelRow.modelId, stream, max_tokens: 200, temperature: 0.3,
        messages: [
          { role: "system", content: "System instructions" },
          { role: "developer", content: "Developer instructions" },
          { role: "user", content: "Earlier question" },
          { role: "assistant", content: "Earlier answer" },
          { role: "user", content: [{ type: "text", text: "Context" }, { type: "text", text: "Final question" }] },
        ],
        tools: functions.map(fn => ({ type: "function", function: fn })), tool_choice: "required",
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.streaming).toBe(stream);
      const input = sent[0]!.input;
      expect(input.system).toEqual([...system, ...(managedCache ? [longCachePoint] : [])]);
      expect(input.toolConfig).toEqual({ tools: [...tools, ...(managedCache ? [longCachePoint] : [])], toolChoice: { any: {} } });
      expect(input.messages).toEqual([
        ...messages.slice(0, -1),
        { ...messages[2]!, content: [...messages[2]!.content, ...(managedCache ? [shortCachePoint] : [])] },
      ]);
      expect(input.inferenceConfig).toEqual({ maxTokens: 200, temperature: 0.3 });
    });
  }

  for (const endpoint of ["converse", "converse-stream"] as const) for (const managedCache of [false, true]) {
    test(`native ${endpoint} caches only final boundaries (managedCache=${managedCache})`, async () => {
      modelRow = model({ managedCache });
      const original = {
        modelId: modelRow.modelId as string, system, messages,
        toolConfig: { tools, toolChoice: { auto: {} } },
        inferenceConfig: { maxTokens: 200, temperature: 0.3, stopSequences: ["STOP"] },
        additionalModelRequestFields: { custom_option: "keep" },
      };
      const response = await nativeCall(endpoint, original);
      expect(response.status).toBe(200);
      await response.text();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.streaming).toBe(endpoint === "converse-stream");
      expect(sent[0]!.input).toEqual({
        ...original,
        system: [...system, ...(managedCache ? [longCachePoint] : [])],
        toolConfig: { ...original.toolConfig, tools: [...tools, ...(managedCache ? [longCachePoint] : [])] },
        messages: [...messages.slice(0, -1), {
          ...messages[2]!, content: [...messages[2]!.content, ...(managedCache ? [shortCachePoint] : [])],
        }],
      });
    });
  }

  for (const endpoint of ["invoke", "invoke-stream"] as const) for (const managedCache of [false, true]) {
    for (const serialized of [false, true]) {
      test(`native ${endpoint} caches system/tools/messages (managedCache=${managedCache}, serialized=${serialized})`, async () => {
        modelRow = model({ managedCache });
        converseOutput = { body: new TextEncoder().encode('{"usage":{"input_tokens":2,"output_tokens":3}}') };
        const original = {
          anthropic_version: "bedrock-2023-05-31", max_tokens: 200, temperature: 0.3,
          system: system.map(block => ({ type: "text", text: block.text })),
          tools: functions.map(({ parameters, ...spec }) => ({ ...spec, input_schema: parameters })),
          tool_choice: { type: "auto" }, stop_sequences: ["STOP"],
          messages: messages.map(message => ({ ...message, content: message.content.map(block => ({ type: "text", text: block.text })) })),
          metadata: { user_id: "cache-test" },
        };
        // Whitespace makes disabled caching's byte-for-byte preservation observable.
        const serializedBody = JSON.stringify(original, null, 2);
        const response = await nativeCall(endpoint, {
          modelId: modelRow.modelId, body: serialized ? serializedBody : original,
          contentType: "application/json", accept: "application/json", trace: "ENABLED",
        });
        expect(response.status).toBe(200);
        await response.text();
        expect(sent).toHaveLength(1);
        const input = sent[0]!.input as unknown as { body: Uint8Array };
        expect(input).toMatchObject({ modelId: modelRow.modelId, contentType: "application/json", accept: "application/json", trace: "ENABLED" });
        const outbound = new TextDecoder().decode(input.body);
        expect(JSON.parse(outbound)).toEqual(managedCache ? {
          ...original,
          system: [original.system[0], { ...original.system[1], ...cacheControl }],
          tools: [original.tools[0], { ...original.tools[1], ...cacheControl }],
          messages: [...original.messages.slice(0, -1), {
            ...original.messages[2], content: [original.messages[2]!.content[0], { ...original.messages[2]!.content[1], ...cacheControl }],
          }],
        } : original);
        if (serialized && !managedCache) expect(outbound).toBe(serializedBody);
      });
    }

    test(`native ${endpoint} preserves malformed and non-object serialized bodies (managedCache=${managedCache})`, async () => {
      modelRow = model({ managedCache });
      converseOutput = { body: new TextEncoder().encode("{}") };
      for (const body of ["{invalid JSON", " null ", " [1, 2] ", ' "text" ', " 42 ", " true "]) {
        sent = [];
        const response = await nativeCall(endpoint, { modelId: modelRow.modelId, body, contentType: "application/json" });
        expect(response.status).toBe(200);
        await response.text();
        expect(sent).toHaveLength(1);
        expect(new TextDecoder().decode((sent[0]!.input as unknown as { body: Uint8Array }).body)).toBe(body);
      }
    });
  }
});

describe("OpenAI-compatible handler", () => {
  test("stream accounting waits for ledger completion and precedes DONE", async () => {
    let release!: () => void;
    settlementGate = new Promise<void>(resolve => { release = resolve; });
    streamEvents = [{ metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } }];
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
      streamEvents = [{ metadata: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5,
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
  for (const stream of [false, true]) {
    for (const publicId of ["opus-max-thinking", "chat-app-max"]) {
      test(`client alias respects OpenAI reasoning_effort (${publicId}, stream=${stream})`, async () => {
        configureAlias();
        aliases[0]!.reasoningSource = "client";
        modelRow = model({ modelId: "anthropic.claude-opus-5", defaultReasoningEffort: "high" });
        streamEvents = [{ messageStart: { role: "assistant" } }, { metadata: { usage: { inputTokens: 2, outputTokens: 3 } } }];
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
