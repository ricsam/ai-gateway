import { describe, expect, test } from "bun:test";
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { addConverseCachePoints } from "./cache-converse";
import { addInvokeBodyCacheControl, addInvokeCacheControl, type AnthropicInvokeBody } from "./cache-invoke";
import { planCachePoints, type CacheTtl } from "./cache-policy";

const longPoint = { cachePoint: { type: "default" as const, ttl: "1h" as const } };
const shortPoint = { cachePoint: { type: "default" as const, ttl: "5m" as const } };
const longControl = { type: "ephemeral" as const, ttl: "1h" as const };
const shortControl = { type: "ephemeral" as const };

function converse(): ConverseCommandInput {
  return {
    modelId: "anthropic.claude-sonnet-4-6",
    system: [{ text: "First instruction" }, { text: "Last instruction" }],
    toolConfig: {
      tools: ["search", "lookup"].map(name => ({ toolSpec: { name, inputSchema: { json: { type: "object" } } } })),
      toolChoice: { any: {} },
    },
    messages: [
      { role: "user", content: [{ text: "Earlier question" }] },
      { role: "assistant", content: [{ text: "Earlier answer" }] },
      { role: "user", content: [{ text: "Context" }, { text: "Question" }] },
    ],
    inferenceConfig: { maxTokens: 100 },
  };
}

function invoke(): AnthropicInvokeBody {
  return {
    anthropic_version: "bedrock-2023-05-31", max_tokens: 100,
    system: [{ type: "text", text: "First instruction" }, { type: "text", text: "Last instruction" }],
    tools: ["search", "lookup"].map(name => ({ name, input_schema: { type: "object" } })),
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: [{ type: "text", text: "Context" }, { type: "text", text: "Question" }] },
    ],
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("Converse cache boundaries", () => {
  test("adds only final boundaries without mutating any caller data; repeated injection is idempotent", () => {
    const request = freeze(converse());
    const original = structuredClone(request);
    const result = addConverseCachePoints(request);
    expect(result.system).toEqual([...request.system!, longPoint]);
    expect(result.toolConfig).toEqual({ ...request.toolConfig, tools: [...request.toolConfig!.tools!, longPoint] });
    expect(result.messages).toEqual([...request.messages!.slice(0, -1), {
      ...request.messages!.at(-1)!, content: [...request.messages!.at(-1)!.content!, shortPoint],
    }]);
    expect(result.inferenceConfig).toEqual(request.inferenceConfig);
    expect(request).toEqual(original);
    expect(addConverseCachePoints(result)).toEqual(result);
  });

  test("retains existing boundary TTLs and uses 5m after a caller's default-TTL tool marker", () => {
    const request = converse();
    request.toolConfig!.tools!.push({ cachePoint: { type: "default" } });
    const result = addConverseCachePoints(freeze(request));
    expect(result.toolConfig).toEqual(request.toolConfig);
    expect(result.system).toEqual([...request.system!, shortPoint]);
    expect(result.messages!.at(-1)!.content!.at(-1)).toEqual(shortPoint);
    expect(addConverseCachePoints(result)).toEqual(result);
  });

  test("counts all existing points and prioritizes tool/system boundaries within the four-point budget", () => {
    const request = converse();
    request.messages![0]!.content!.push(shortPoint);
    request.messages![1]!.content!.push(shortPoint);
    const result = addConverseCachePoints(freeze(request));
    expect(result.toolConfig!.tools!.at(-1)).toEqual(longPoint);
    expect(result.system!.at(-1)).toEqual(longPoint);
    expect(result.messages).toEqual(request.messages);
    expect(addConverseCachePoints(result)).toEqual(result);
  });

  test("does not add markers when all slots are already used", () => {
    const request = converse();
    request.messages![0]!.content!.push(...Array.from({ length: 4 }, () => shortPoint));
    expect(addConverseCachePoints(freeze(request))).toEqual(request);
  });

  test("handles missing and empty sections without inventing content", () => {
    for (const request of [
      { modelId: "m" },
      { modelId: "m", system: [], toolConfig: { tools: [] }, messages: [] },
      { modelId: "m", messages: [{ role: "user" as const, content: [] }] },
    ]) expect(addConverseCachePoints(freeze(request))).toEqual(request);
  });
});

describe("Anthropic Invoke cache boundaries", () => {
  test("marks only final blocks and tools without mutation; retains all other fields", () => {
    const body = freeze(invoke());
    const original = structuredClone(body);
    const result = addInvokeCacheControl(body);
    expect(result).toEqual({
      ...body,
      system: [{ type: "text", text: "First instruction" }, { type: "text", text: "Last instruction", cache_control: shortControl }],
      tools: [body.tools![0]!, { ...body.tools![1]!, cache_control: shortControl }],
      messages: [...body.messages!.slice(0, -1), {
        role: "user", content: [{ type: "text", text: "Context" }, { type: "text", text: "Question", cache_control: shortControl }],
      }],
    });
    expect(body).toEqual(original);
    expect(addInvokeCacheControl(result)).toEqual(result);
  });

  test("caches system and tools independently when other sections are absent", () => {
    expect(addInvokeCacheControl({ system: "Instructions" })).toEqual({
      system: [{ type: "text", text: "Instructions", cache_control: shortControl }],
    });
    expect(addInvokeCacheControl({ tools: [{ name: "search" }] })).toEqual({
      tools: [{ name: "search", cache_control: shortControl }],
    });
    expect(addConverseCachePoints({ modelId: "m", system: [{ text: "Instructions" }] }).system)
      .toEqual([{ text: "Instructions" }, longPoint]);
    expect(addConverseCachePoints({ modelId: "m", toolConfig: { tools: [{ toolSpec: { name: "search", inputSchema: { json: {} } } }] } }).toolConfig?.tools?.at(-1))
      .toEqual(longPoint);
  });

  test("keeps all explicit Invoke boundaries including the final message TTL unchanged", () => {
    const body: AnthropicInvokeBody = {
      tools: [{ name: "search", cache_control: longControl }],
      system: [{ type: "text", text: "Instructions", cache_control: longControl }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: longControl }] }],
    };
    expect(addInvokeCacheControl(freeze(body))).toEqual(body);
  });

  test("does not exceed the Invoke checkpoint budget", () => {
    const body = invoke();
    body.messages![0]!.content = Array.from({ length: 4 }, () => ({ type: "text", text: "Cached", cache_control: shortControl }));
    expect(addInvokeCacheControl(freeze(body))).toEqual(body);
  });

  test("normalizes string system and message content", () => {
    expect(addInvokeCacheControl({ system: "Instructions", messages: [{ role: "user", content: "Hi" }] })).toEqual({
      system: [{ type: "text", text: "Instructions", cache_control: shortControl }],
      messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: shortControl }] }],
    });
  });

  test("preserves caller 1h controls and does not insert a shorter TTL ahead of them", () => {
    const body = invoke();
    body.system = [{ type: "text", text: "Instructions", cache_control: longControl }];
    const result = addInvokeCacheControl(freeze(body));
    expect(result.system).toEqual(body.system);
    expect(result.tools!.at(-1)!.cache_control).toEqual(longControl);
    expect(result.messages!.at(-1)!.content).toEqual([
      { type: "text", text: "Context" }, { type: "text", text: "Question", cache_control: shortControl },
    ]);
    expect(addInvokeCacheControl(result)).toEqual(result);
  });

  test("counts existing message markers toward the limit and prefers stable sections", () => {
    const body = invoke();
    body.messages![0]!.content = [
      { type: "text", text: "First", cache_control: shortControl },
      { type: "text", text: "Second", cache_control: shortControl },
    ];
    const result = addInvokeCacheControl(freeze(body));
    expect(result.tools!.at(-1)!.cache_control).toEqual(shortControl);
    expect(result.system).toEqual([
      { type: "text", text: "First instruction" }, { type: "text", text: "Last instruction", cache_control: shortControl },
    ]);
    expect(result.messages).toEqual(body.messages);
    expect(addInvokeCacheControl(result)).toEqual(result);
  });

  test("does not mark empty sections, empty text, or thinking blocks", () => {
    for (const body of [
      {}, { system: [], tools: [], messages: [] }, { system: "", messages: [{ role: "user", content: "" }] },
      { system: "  ", messages: [{ role: "user", content: [] }] },
      { system: [{ type: "text", text: "" }], messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "Thought", signature: "sig" }] }] },
    ] as AnthropicInvokeBody[]) expect(addInvokeCacheControl(freeze(body))).toEqual(body);
  });

  test("tool-result content keeps its payload and can be the final boundary", () => {
    const content = { type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "Found it" }] };
    const result = addInvokeCacheControl({ messages: [{ role: "user", content: [content] }] });
    expect(result.messages![0]!.content).toEqual([{ ...content, cache_control: shortControl }]);
  });

  test("handles object and serialized bodies, including opaque Anthropic profiles", () => {
    const body = invoke();
    expect(addInvokeBodyCacheControl(body, "anthropic.claude-sonnet-4-6")).toEqual(addInvokeCacheControl(body));
    expect(addInvokeBodyCacheControl(JSON.stringify(body), "opaque-profile")).toEqual(addInvokeCacheControl(body));
  });

  test("leaves other providers and malformed/non-object bodies unchanged", () => {
    const nova = { system: [{ text: "Nova system" }], messages: [{ role: "user", content: [{ text: "Hi" }] }] };
    for (const value of [nova, JSON.stringify(nova)]) expect(addInvokeBodyCacheControl(value, "amazon.nova-pro-v1:0")).toBe(value);
    for (const value of [undefined, null, [], new Uint8Array([1, 2]), "{oops", " null ", " [] ", " 42 "]) {
      expect(addInvokeBodyCacheControl(value, "anthropic.claude-sonnet-4-6")).toBe(value);
    }
  });
});

describe("cache checkpoint planning", () => {
  test("does not compound an already invalid short-before-long caller policy", () => {
    expect(planCachePoints([
      { existing: ["5m"], needsCheckpoint: true, preferredTtl: "1h" },
      { existing: ["1h"], needsCheckpoint: false, preferredTtl: "1h" },
    ])).toEqual([undefined, undefined]);
  });

  test("all valid caller TTL combinations remain ordered and within budget", () => {
    const options: Array<Array<CacheTtl | undefined>> = [[], [undefined], ["5m"], ["1h"], ["1h", "1h"]];
    for (const tools of options) for (const system of options) for (const messages of options) {
      const existing = [tools, system, messages];
      const oldTtls = existing.flat().map(ttl => ttl ?? "5m");
      if (oldTtls.length > 4 || oldTtls.some((ttl, index) => ttl === "1h" && oldTtls.slice(0, index).includes("5m"))) continue;
      const additions = planCachePoints(existing.map((points, index) => ({ existing: points, needsCheckpoint: true, preferredTtl: index < 2 ? "1h" : "5m" })));
      const ttls = existing.flatMap((points, index) => [...points.map(ttl => ttl ?? "5m"), ...(additions[index] ? [additions[index]!] : [])]);
      expect(ttls.length).toBeLessThanOrEqual(4);
      expect(ttls.some((ttl, index) => ttl === "1h" && ttls.slice(0, index).includes("5m"))).toBe(false);
    }
  });
});
