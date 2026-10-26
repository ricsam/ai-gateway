import { describe, expect, test } from "bun:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { ConversationCache, readConversationId, type ConversationCacheContext } from "./conversation-cache";
import type { ConversationBoundaryStore, StoredConversationBoundary } from "./conversation-cache-types";
import { addConverseCachePoints } from "./openai-proxy/transform/cache-converse";
import { addInvokeCacheControl, type AnthropicInvokeBody } from "./openai-proxy/transform/cache-invoke";
import { finalCacheBoundary } from "./openai-proxy/transform/cache-prefix";

const context: ConversationCacheContext = {
  conversationId: "thread-1", principal: { userId: "owner", credentialType: "api_key", credentialId: "key-1" },
  modelKey: "model-row", modelId: "anthropic.claude-sonnet-4-6", region: "us-east-1",
};
function input(): ConverseCommandInput {
  return {
    modelId: context.modelId,
    system: [{ text: "Stable instructions" }],
    toolConfig: { tools: [{ toolSpec: { name: "search", inputSchema: { json: { type: "object" } } } }] },
    messages: [{ role: "user", content: [{ text: "Initial question" }] }],
  };
}
function next(): ConverseCommandInput {
  const request = input();
  request.messages!.push(
    { role: "assistant", content: [{ text: "Answer" }] },
    { role: "user", content: Array.from({ length: 25 }, (_, i) => ({ text: `New block ${i}` })) },
  );
  return request;
}
function setup() {
  let now = 100_000;
  const rows = new Map<string, StoredConversationBoundary>();
  const writes: Parameters<ConversationBoundaryStore["put"]>[0][] = [];
  const store: ConversationBoundaryStore = {
    async get(key) { const row = rows.get(key); return row && row.expiresAt > now ? row : undefined; },
    async put(value) {
      writes.push(value);
      const old = rows.get(value.key);
      if (value.expectedVersion === null ? old && old.expiresAt > now : old?.version !== value.expectedVersion) return;
      rows.set(value.key, { version: crypto.randomUUID(), boundary: value.boundary, expiresAt: value.expiresAt });
    },
  };
  return { cache: new ConversationCache(async () => store, () => now), rows, writes, advance: (ms: number) => { now += ms; } };
}
function countMarkers(request: unknown) {
  return (JSON.stringify(request).match(/"cachePoint"|"cache_control"/g) ?? []).length;
}

describe("conversation ID contract", () => {
  test("missing opts out; UUIDs and bounded opaque IDs work case-insensitively", () => {
    expect(readConversationId(new Headers())).toBeUndefined();
    for (const value of [crypto.randomUUID(), "org.thread_1:branch-a", "a".repeat(128)]) {
      expect(readConversationId(new Headers({ "X-Conversation-ID": value }))).toBe(value);
    }
  });
  test("rejects empty, multiple, overlong and unsafe IDs", () => {
    for (const value of ["", " ", "a".repeat(129), "a,b", "a b", "email@example.com", "path/to/thread"]) {
      expect(() => readConversationId(new Headers({ "x-conversation-id": value }))).toThrow("X-Conversation-ID");
    }
    const headers = new Headers({ "x-conversation-id": "one" });
    headers.append("X-Conversation-ID", "two");
    expect(() => readConversationId(headers)).toThrow();
  });
});

describe("conversation cache continuity", () => {
  test("restores the previous INPUT endpoint beyond 20 blocks and advances after acceptance", async () => {
    const { cache, rows, writes } = setup();
    const first = await cache.converse(input(), context);
    expect(rows.size).toBe(0);
    await first.accepted();
    await first.accepted();
    expect(writes).toHaveLength(1);
    const second = await cache.converse(next(), context);
    expect(second.input.messages![0]!.content!.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "5m" } });
    expect(second.input.messages![1]!.content).toEqual([{ text: "Answer" }]);
    expect(second.input.messages!.at(-1)!.content!.at(-1)).toEqual({ cachePoint: { type: "default", ttl: "5m" } });
    expect(countMarkers(second.input)).toBe(4);
    expect(writes[0]!.boundary).toMatchObject({ messageIndex: 0, contentIndex: 0, ttl: "5m" });
    await second.accepted();
    expect(writes[1]!.boundary).toMatchObject({ messageIndex: 2, contentIndex: 24 });
    expect(writes[1]!.expectedVersion).not.toBeNull();
    expect(JSON.stringify(writes)).not.toContain("Initial question");
    expect(JSON.stringify(writes)).not.toContain(context.conversationId!);
  });

  test("uses exact content positions when the final same-role message grows", async () => {
    const { cache } = setup();
    await (await cache.converse(input(), context)).accepted();
    const request = input();
    request.messages![0]!.content!.push(...Array.from({ length: 25 }, (_, i) => ({ text: `Append ${i}` })));
    const prepared = await cache.converse(request, context);
    expect(prepared.input.messages![0]!.content![1]?.cachePoint?.ttl).toBe("5m");
    expect(prepared.input.messages![0]!.content!.at(-1)?.cachePoint?.ttl).toBe("5m");
    expect(countMarkers(prepared.input)).toBe(4);
    expect(request.messages![0]!.content).toHaveLength(26);
  });

  test("only accepted requests are remembered; expired hints are ignored", async () => {
    const { cache, advance, rows } = setup();
    await cache.converse(input(), context); // simulates an upstream failure
    expect(countMarkers((await cache.converse(next(), context)).input)).toBe(3);
    expect(rows.size).toBe(0);
    await (await cache.converse(input(), context)).accepted();
    advance(300_001);
    expect(countMarkers((await cache.converse(next(), context)).input)).toBe(3);
    const delayed = await cache.converse(input(), context);
    advance(300_001);
    await delayed.accepted();
    expect([...rows.values()][0]!.expiresAt).toBe(400_000);
  });

  test("all absent-ID requests retain stateless caching without opening storage", async () => {
    const cache = new ConversationCache(async () => { throw new Error("must not open storage"); });
    const prepared = await cache.converse(input(), { ...context, conversationId: undefined });
    expect(prepared.input).toEqual(addConverseCachePoints(input()));
    await prepared.accepted();
  });

  test("separates callers, credentials, IDs, upstream models and regions", async () => {
    const { cache } = setup();
    await (await cache.converse(input(), context)).accepted();
    const alternatives: ConversationCacheContext[] = [
      { ...context, conversationId: "other" }, { ...context, modelId: "other" }, { ...context, modelKey: "other" },
      { ...context, region: "eu-west-1" },
      { ...context, principal: { ...context.principal, userId: "other" } },
      { ...context, principal: { ...context.principal, credentialId: "other" } },
      { ...context, principal: { ...context.principal, credentialType: "session" } },
    ];
    for (const alternative of alternatives) expect(countMarkers((await cache.converse(next(), alternative)).input)).toBe(3);
  });

  test("changed prompt prefixes and provider options never reuse a stale position", async () => {
    const { cache } = setup();
    await (await cache.converse(input(), context)).accepted();
    for (const change of [
      (r: ConverseCommandInput) => { r.system = [{ text: "Changed instructions" }]; },
      (r: ConverseCommandInput) => { r.toolConfig!.tools![0]!.toolSpec!.name = "other"; },
      (r: ConverseCommandInput) => { r.messages![0]!.content = [{ text: "Compacted history" }]; },
      (r: ConverseCommandInput) => { r.additionalModelRequestFields = { thinking: { type: "disabled" } }; },
    ]) {
      const request = next(); change(request);
      expect(countMarkers((await cache.converse(request, context)).input)).toBe(3);
    }
    const compacted = { ...input(), messages: [] };
    expect(countMarkers((await cache.converse(compacted, context)).input)).toBe(2);
  });

  test("stale concurrent acceptances cannot replace the winner", async () => {
    const { cache, rows } = setup();
    await (await cache.converse(input(), context)).accepted();
    const a = await cache.converse(next(), context);
    const b = await cache.converse(input(), context);
    await a.accepted();
    const winner = structuredClone([...rows.values()][0]);
    await b.accepted();
    expect([...rows.values()][0]).toEqual(winner);
  });

  test("read/write storage failures fail open and never leak IDs into logs", async () => {
    const readFail = new ConversationCache(async () => { throw new Error("secret details"); });
    const request = await readFail.converse(input(), context);
    expect(countMarkers(request.input)).toBe(3);
    await request.accepted();
    const writeFail = new ConversationCache(async () => ({ async get() { return undefined; }, async put() { throw new Error("secret details"); } }));
    await (await writeFail.converse(input(), context)).accepted();
  });

  test("hung metadata reads and writes have a bounded fail-open deadline", async () => {
    const never = () => new Promise<never>(() => {});
    const slowRead = new ConversationCache(async () => ({ get: never, put: never }), Date.now, 10);
    const readStarted = Date.now();
    expect(countMarkers((await slowRead.converse(input(), context)).input)).toBe(3);
    expect(Date.now() - readStarted).toBeLessThan(500);
    const slowWrite = new ConversationCache(async () => ({ async get() { return undefined; }, put: never }), Date.now, 10);
    const prepared = await slowWrite.converse(input(), context);
    const writeStarted = Date.now();
    await prepared.accepted();
    expect(Date.now() - writeStarted).toBeLessThan(500);
  });

  test("Invoke object/string bodies share boundaries, and format scopes remain separate", async () => {
    const { cache } = setup();
    const body: AnthropicInvokeBody = {
      anthropic_version: "bedrock-2023-05-31", system: "Instructions", tools: [{ name: "search" }],
      messages: [{ role: "user", content: "Initial question" }],
    };
    await (await cache.invoke(JSON.stringify(body), context.modelId, context)).accepted();
    const extended = structuredClone(body);
    extended.messages!.push({ role: "assistant", content: "Answer" }, {
      role: "user", content: Array.from({ length: 25 }, (_, i) => ({ type: "text", text: `Block ${i}` })),
    });
    const result = (await cache.invoke(extended, context.modelId, context)).input as AnthropicInvokeBody;
    expect(result.messages![0]!.content).toEqual([{ type: "text", text: "Initial question", cache_control: { type: "ephemeral" } }]);
    expect(countMarkers(result)).toBe(4);
    expect(countMarkers((await cache.converse(next(), context)).input)).toBe(3);
  });
});

describe("previous-boundary transform safety", () => {
  test("same input retries deduplicate the previous/current checkpoint", () => {
    const marked = addConverseCachePoints(input());
    const previous = finalCacheBoundary(marked, "converse");
    expect(addConverseCachePoints(input(), previous)).toEqual(marked);
    expect(addConverseCachePoints(marked, previous)).toEqual(marked);
  });

  test("caller markers consume slots, keep TTLs, and are not duplicated", () => {
    const marked = addConverseCachePoints(input());
    const previous = finalCacheBoundary(marked, "converse");
    const request = next();
    request.messages![0]!.content!.push({ cachePoint: { type: "default", ttl: "1h" } });
    const result = addConverseCachePoints(request, previous);
    expect(result.messages![0]!.content).toEqual(request.messages![0]!.content);
    expect(countMarkers(result)).toBe(4);
    expect(result.messages!.at(-1)!.content!.at(-1)?.cachePoint?.ttl).toBe("5m");
  });

  test("does not remember a request without a final marker when the budget is exhausted", () => {
    const request = input();
    request.system!.push(...Array.from({ length: 4 }, () => ({ cachePoint: { type: "default" as const, ttl: "1h" as const } })));
    const marked = addConverseCachePoints(request);
    expect(finalCacheBoundary(marked, "converse")).toBeUndefined();
  });

  test("Invoke restores a one-hour previous marker without changing explicit controls", () => {
    const body: AnthropicInvokeBody = {
      system: "Instructions", tools: [{ name: "search" }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
    };
    const marked = addInvokeCacheControl(body);
    const previous = finalCacheBoundary(marked, "invoke");
    const nextBody = structuredClone(body);
    nextBody.messages = [{ role: "user", content: [{ type: "text", text: "Hi" }, { type: "text", text: "New" }] }];
    const result = addInvokeCacheControl(nextBody, previous);
    expect(countMarkers(result)).toBe(4);
    expect(result.messages![0]!.content).toEqual([
      { type: "text", text: "Hi", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: "New", cache_control: { type: "ephemeral" } },
    ]);
  });
});
