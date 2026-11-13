import { describe, expect, test } from "bun:test";
import type { ContentBlock, ConverseCommandInput, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { addConverseCachePoints } from "./cache-converse";
import {
  applyReasoningReplay,
  canonicalJson,
  captureConverseReasoning,
  conversationPrefixHashes,
  inputTransformations,
  isReplayRejection,
  messageLookupKey,
  planReasoningReplay,
  rejectsBindingControls,
  requestThinkingType,
  StreamingReasoningCapture,
  THINKING_BINDING_BETA,
  withThinkingBindingControls,
  type CapturedReasoning,
  type ReplayEntry,
} from "./reasoning-replay";
import { transformRequest } from "./request";
import type { OpenAIAssistantMessage, OpenAIMessage, OpenAITool } from "./types";

const TOOLS: OpenAITool[] = [{
  type: "function",
  function: { name: "weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
}];

function request(messages: OpenAIMessage[], options: { system?: string; tools?: OpenAITool[] } = {}): ConverseCommandInput {
  return transformRequest({
    model: "eu.anthropic.claude-opus-5-5",
    messages: [{ role: "system", content: options.system ?? "You are a weather agent." }, ...messages],
    tools: options.tools ?? TOOLS,
    max_tokens: 64000,
  });
}

function captureStream(events: ConverseStreamOutput[]): CapturedReasoning | null {
  const capture = new StreamingReasoningCapture();
  for (const event of events) {
    const toolUse = event.contentBlockStart?.start?.toolUse;
    if (toolUse) capture.toolUseStart(event.contentBlockStart!.contentBlockIndex!, toolUse.toolUseId!, toolUse.name!);
    if (event.contentBlockDelta) capture.delta(event.contentBlockDelta.contentBlockIndex!, event.contentBlockDelta.delta);
  }
  return capture.finish();
}

let entryCount = 0;
/** The entry the gateway stores for the response to `sent`, as produced after `predecessorId`. */
function stored(sent: ConverseCommandInput, reasoning: CapturedReasoning | null, predecessorId: string | null = null): ReplayEntry {
  if (!reasoning) throw new Error("expected reasoning");
  return { id: `entry-${++entryCount}`, prefixHash: conversationPrefixHashes(sent).at(-1)!, predecessorId, ...reasoning };
}

function replay(sent: ConverseCommandInput, entries: ReplayEntry[]) {
  const plan = planReasoningReplay(sent.messages!, conversationPrefixHashes(sent), entries);
  return { plan, messages: applyReasoningReplay(sent.messages!, plan) };
}

const thinking = (text: string, signature: string): ContentBlock => ({ reasoningContent: { reasoningText: { text, signature } } });

/** A Bedrock response with one thinking block, as the gateway returns it to the client. */
function step(index: number, options: { toolId?: string; text?: string } = {}) {
  const text = options.text ?? `Step ${index}.`;
  const content: ContentBlock[] = [
    thinking(`Reasoning for step ${index}.`, `sig-${index}`),
    { text },
    ...(options.toolId ? [{ toolUse: { toolUseId: options.toolId, name: "weather", input: { city: `City ${index}` } } }] : []),
  ];
  const assistant: OpenAIAssistantMessage = {
    role: "assistant",
    content: text,
    ...(options.toolId && { tool_calls: [{ id: options.toolId, type: "function", function: { name: "weather", arguments: JSON.stringify({ city: `City ${index}` }) } }] }),
  };
  return { content, assistant, reasoning: captureConverseReasoning(content, { content: assistant.content as string, tool_calls: assistant.tool_calls }) };
}

const user: OpenAIMessage = { role: "user", content: "What is the weather in Stockholm?" };
const STREAMED_STEP: ConverseStreamOutput[] = [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "The user wants Stockholm " } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "weather; call the tool." } } } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-streamed" } } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } } } },
  { contentBlockStop: { contentBlockIndex: 1 } },
  { contentBlockDelta: { contentBlockIndex: 2, delta: { text: "Let me check." } } },
  { contentBlockStop: { contentBlockIndex: 2 } },
  { contentBlockStart: { contentBlockIndex: 3, start: { toolUse: { toolUseId: "tooluse_1", name: "weather" } } } },
  { contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: "{\"city\":" } } } },
  { contentBlockDelta: { contentBlockIndex: 3, delta: { toolUse: { input: "\"Stockholm\"}" } } } },
  { contentBlockStop: { contentBlockIndex: 3 } },
  { messageStop: { stopReason: "tool_use" } },
] as ConverseStreamOutput[];
const STREAMED_ASSISTANT: OpenAIAssistantMessage = {
  role: "assistant",
  content: "Let me check.",
  tool_calls: [{ id: "tooluse_1", type: "function", function: { name: "weather", arguments: "{\"city\":\"Stockholm\"}" } }],
};
const TOOL_RESULT: OpenAIMessage = { role: "tool", tool_call_id: "tooluse_1", content: "{\"temperature\":18}" };

describe("reasoning capture", () => {
  test("joins streamed reasoning text, keeps its signature and redacted blocks, and keys by the first tool call", () => {
    const captured = captureStream(STREAMED_STEP);
    expect(captured).toMatchObject({
      lookupKey: "tool:tooluse_1",
      blocks: [
        { position: 0, block: { type: "text", text: "The user wants Stockholm weather; call the tool.", signature: "sig-streamed" } },
        { position: 0, block: { type: "redacted", data: Buffer.from([1, 2, 3]).toString("base64") } },
      ],
    });
    expect(captured!.visible).toHaveLength(2);
  });

  test("keys non-streaming responses by the tool call IDs and text the client receives", () => {
    const content: ContentBlock[] = [thinking("Plan.", "sig"), { text: "Calling" }, { toolUse: { toolUseId: undefined, name: "weather", input: {} } } as ContentBlock];
    expect(captureConverseReasoning(content, { content: "Calling", tool_calls: [{ id: "call_generated" }] })?.lookupKey).toBe("tool:call_generated");

    const answer = captureConverseReasoning([thinking("Done thinking.", "sig"), { text: "A" }, { text: "B" }], { content: "A\nB" });
    expect(answer?.lookupKey).toBe(messageLookupKey({ role: "assistant", content: [{ text: "A\nB" }] })!);
  });

  test("keeps empty thinking text with its signature, which still carries the reasoning", () => {
    const captured = captureConverseReasoning([thinking("", "sig-omitted"), { text: "Hi" }], { content: "Hi" });
    expect(captured?.blocks).toEqual([{ position: 0, block: { type: "text", text: "", signature: "sig-omitted" } }]);
  });

  test("stores nothing it cannot send back", () => {
    const unsigned = STREAMED_STEP.filter((event) => !event.contentBlockDelta?.delta?.reasoningContent?.signature);
    expect(captureStream(unsigned)).toBeNull();
    expect(captureConverseReasoning([{ reasoningContent: { reasoningText: { text: "No signature" } } }, { text: "Hi" }], { content: "Hi" })).toBeNull();
    expect(captureConverseReasoning([{ text: "No reasoning" }], { content: "No reasoning" })).toBeNull();
    // Reasoning without text or tool calls cannot be matched to a turn.
    expect(captureConverseReasoning([thinking("Only thought.", "sig")], { content: null })).toBeNull();
  });
});

describe("reasoning replay", () => {
  test("puts reasoning back in its original position, with text and signature unmodified", () => {
    const entry = stored(request([user]), captureStream(STREAMED_STEP));
    const next = request([user, STREAMED_ASSISTANT, TOOL_RESULT]);
    const { plan, messages } = replay(next, [entry]);
    expect(messages[1]!.content).toEqual([
      thinking("The user wants Stockholm weather; call the tool.", "sig-streamed"),
      { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
      { text: "Let me check." },
      { toolUse: { toolUseId: "tooluse_1", name: "weather", input: { city: "Stockholm" } } },
    ]);
    expect(messages[0]).toEqual(next.messages![0]!);
    expect(messages[2]).toEqual(next.messages![2]!);
    expect(plan.lastEntryId).toBe(entry.id);
    expect(plan.stats).toEqual({ assistantTurns: 1, matched: 1, stale: 0, unchained: 0, replayedEntries: 1, replayedBlocks: 2 });
  });

  test("keeps reasoning that followed text in place after that text", () => {
    const content: ContentBlock[] = [{ text: "First I check." }, thinking("Now the city.", "sig-mid"), { toolUse: { toolUseId: "tooluse_mid", name: "weather", input: { city: "Oslo" } } }];
    const assistant: OpenAIAssistantMessage = { role: "assistant", content: "First I check.", tool_calls: [{ id: "tooluse_mid", type: "function", function: { name: "weather", arguments: "{\"city\":\"Oslo\"}" } }] };
    const entry = stored(request([user]), captureConverseReasoning(content, { content: "First I check.", tool_calls: assistant.tool_calls }));
    const { messages } = replay(request([user, assistant, { role: "tool", tool_call_id: "tooluse_mid", content: "rain" }]), [entry]);
    expect(messages[1]!.content).toEqual(content);
  });

  test("keeps the position when a client splits the turn into consecutive assistant messages", () => {
    const entry = stored(request([user]), captureStream(STREAMED_STEP));
    const split: OpenAIMessage[] = [user, { role: "assistant", content: "Let me check." }, { role: "assistant", content: null, tool_calls: STREAMED_ASSISTANT.tool_calls }, TOOL_RESULT];
    const next = request(split);
    expect(next.messages).toHaveLength(3);
    const { messages } = replay(next, [entry]);
    expect(messages[1]!.content!.map((block) => Object.keys(block)[0])).toEqual(["reasoningContent", "reasoningContent", "text", "toolUse"]);
  });

  test("leaves user messages and unmatched assistant turns untouched", () => {
    const { plan, messages } = replay(request([user, STREAMED_ASSISTANT, TOOL_RESULT]), []);
    expect(plan.insertions.size).toBe(0);
    expect(messages).toEqual(request([user, STREAMED_ASSISTANT, TOOL_RESULT]).messages!);
    expect(plan.stats).toMatchObject({ assistantTurns: 1, matched: 0, replayedEntries: 0 });
  });

  describe("a three-step tool loop", () => {
    const s1 = step(1, { toolId: "tooluse_a" });
    const s2 = step(2, { toolId: "tooluse_b" });
    const s3 = step(3, { text: "It is 18 degrees in Stockholm." });
    const r1: OpenAIMessage = { role: "tool", tool_call_id: "tooluse_a", content: "18" };
    const r2: OpenAIMessage = { role: "tool", tool_call_id: "tooluse_b", content: "sunny" };
    const followUp: OpenAIMessage = { role: "user", content: "Thanks!" };
    const history = [user, s1.assistant, r1, s2.assistant, r2, s3.assistant, followUp];
    const e1 = stored(request([user]), s1.reasoning);
    const e2 = stored(request([user, s1.assistant, r1]), s2.reasoning, e1.id);
    const e3 = stored(request([user, s1.assistant, r1, s2.assistant, r2]), s3.reasoning, e2.id);
    const replayedSignatures = (entries: ReplayEntry[], messages = history, options?: { system?: string; tools?: OpenAITool[] }) =>
      replay(request(messages, options), entries).messages.flatMap((message) => (message.content ?? []).flatMap((block) => block.reasoningContent?.reasoningText?.signature ?? []));

    test("replays every stored step, including the final answer keyed by its text", () => {
      expect(replayedSignatures([e1, e2, e3])).toEqual(["sig-1", "sig-2", "sig-3"]);
    });

    test("replays only the newest unbroken run when an older entry is missing", () => {
      expect(replayedSignatures([e1, e3])).toEqual(["sig-3"]);
      expect(replayedSignatures([e2, e3])).toEqual(["sig-2", "sig-3"]);
      expect(replayedSignatures([e1, e2])).toEqual(["sig-1", "sig-2"]);
      const plan = replay(request(history), [e1, e3]).plan;
      expect(plan.stats).toMatchObject({ matched: 2, unchained: 1, replayedEntries: 1 });
    });

    test("follows the chain each response was produced with", () => {
      // Produced by a retry without replayed reasoning: nothing came before it.
      expect(replayedSignatures([e1, e2, { ...e3, predecessorId: null }])).toEqual(["sig-3"]);
      // Produced while step 2 was not stored yet: step 2 must stay out.
      expect(replayedSignatures([e1, e2, { ...e3, predecessorId: e1.id }])).toEqual(["sig-1", "sig-3"]);
    });

    test("skips reasoning whose earlier conversation changed, and keeps what came before the change", () => {
      const edited = history.map((message) => message === r2 ? { ...r2, content: "cloudy" } : message);
      expect(replayedSignatures([e1, e2, e3], edited)).toEqual(["sig-1", "sig-2"]);
      const editedAnswer = history.map((message) => message === s1.assistant ? { ...s1.assistant, content: "Step one." } : message);
      // Step 1's own reasoning precedes the edited text; later steps saw the original text.
      expect(replayedSignatures([e1, e2, e3], editedAnswer)).toEqual(["sig-1"]);
      expect(replayedSignatures([e1, e2, e3], history, { system: "You are a helpful agent." })).toEqual([]);
      expect(replayedSignatures([e1, e2, e3], history, { tools: [...TOOLS, { type: "function", function: { name: "forecast" } }] })).toEqual([]);
      expect(replay(request(edited), [e1, e2, e3]).plan.stats).toMatchObject({ matched: 3, stale: 1, replayedEntries: 2 });
    });

    test("reasoning produced after a change is replayed with the reasoning before the change", () => {
      const edited = history.map((message) => message === r2 ? { ...r2, content: "cloudy" } : message);
      const e3After = stored(request(edited.slice(0, 5)), s3.reasoning, e2.id);
      expect(replayedSignatures([e1, e2, e3After], edited)).toEqual(["sig-1", "sig-2", "sig-3"]);
    });

    test("ignores cache points, effort and output limits", () => {
      const sent = { ...addConverseCachePoints(request(history)), inferenceConfig: { maxTokens: 1000 } };
      const { plan } = replay(sent, [e1, e2, e3]);
      expect(plan.entryIds).toEqual([e1.id, e2.id, e3.id]);
    });

    test("a repeated identical answer replaces the earlier one and belongs to its last occurrence", () => {
      const s3b = step(4, { text: s3.assistant.content as string });
      const e3b = stored(request(history), s3b.reasoning, e3.id);
      expect(e3b.lookupKey).toBe(e3.lookupKey);
      const again = [...history, s3b.assistant, { role: "user", content: "Once more?" } as OpenAIMessage];
      const { plan } = replay(request(again), [e1, e2, e3b]);
      // Its predecessor was replaced under the same key, so the run starts at it.
      expect([...plan.insertions.keys()]).toEqual([7]);
    });
  });
});

describe("conversation prefix hashes", () => {
  test("cover the system prompt, tools and every message except reasoning and cache points", () => {
    const sent = request([user, STREAMED_ASSISTANT, TOOL_RESULT]);
    const hashes = conversationPrefixHashes(sent);
    expect(hashes).toHaveLength(4);
    const withReasoning = { ...sent, messages: sent.messages!.map((message, index) => index === 1 ? { ...message, content: [thinking("x", "y"), ...message.content!] } : message) };
    expect(conversationPrefixHashes(withReasoning)).toEqual(hashes);
    expect(conversationPrefixHashes(addConverseCachePoints(sent))).toEqual(hashes);
    const question = { type: "text" as const, text: "What is this?" };
    const image = { type: "image_url" as const, image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" } };
    expect(conversationPrefixHashes(request([{ role: "user", content: [question, image] }]))[1])
      .not.toBe(conversationPrefixHashes(request([{ role: "user", content: [question] }]))[1]);
  });

  test("compare tool input as parsed JSON, like Claude's prefix check", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe("{\"a\":[1,{\"d\":2}],\"b\":1}");
    const call = (args: string): OpenAIMessage => ({ role: "assistant", content: null, tool_calls: [{ id: "tooluse_1", type: "function", function: { name: "weather", arguments: args } }] });
    expect(conversationPrefixHashes(request([user, call("{\"city\":\"Stockholm\",\"unit\":\"c\"}"), TOOL_RESULT])))
      .toEqual(conversationPrefixHashes(request([user, call("{ \"unit\": \"c\", \"city\": \"Stockholm\" }"), TOOL_RESULT])));
    expect(conversationPrefixHashes(request([user, call("{\"city\":\"Oslo\"}"), TOOL_RESULT]))[3])
      .not.toBe(conversationPrefixHashes(request([user, call("{\"city\":\"Stockholm\"}"), TOOL_RESULT]))[3]);
  });

  test("lookup keys come from assistant messages only", () => {
    expect(messageLookupKey({ role: "user", content: [{ text: "Hi" }] })).toBeNull();
    expect(messageLookupKey({ role: "assistant", content: [{ text: "Hi" }, { toolUse: { toolUseId: "t1", name: "n", input: {} } }] })).toBe("tool:t1");
    expect(messageLookupKey({ role: "assistant", content: [{ toolUse: { toolUseId: "x".repeat(300), name: "n", input: {} } }] })).toMatch(/^tool-sha256:[0-9a-f]{64}$/);
    expect(messageLookupKey({ role: "assistant", content: [] })).toBeNull();
  });
});

describe("thinking binding controls", () => {
  const adaptive: ConverseCommandInput = {
    modelId: "eu.anthropic.claude-opus-5-5",
    messages: [],
    additionalModelRequestFields: { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" }, anthropic_beta: ["other-beta"] },
  };

  test("ask Claude to drop stale replayed thinking and report it", () => {
    const controlled = withThinkingBindingControls(adaptive);
    expect(controlled.additionalModelRequestFields).toEqual({
      thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      output_config: { effort: "max" },
      anthropic_beta: ["other-beta", THINKING_BINDING_BETA],
    });
    expect(controlled.additionalModelResponseFieldPaths).toEqual(["/input_transformations"]);
    expect(withThinkingBindingControls(controlled)).toEqual(controlled);
    expect(adaptive.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "max" }, anthropic_beta: ["other-beta"] });
  });

  test("leave other thinking configurations alone, which reject block_binding", () => {
    const configurations: Array<Record<string, string | number>> = [{ type: "enabled", budget_tokens: 1024 }, { type: "disabled" }, { type: "between_tools" }];
    for (const thinking of configurations) {
      const input: ConverseCommandInput = { ...adaptive, additionalModelRequestFields: { thinking } };
      expect(withThinkingBindingControls(input)).toBe(input);
      expect(requestThinkingType(input)).toBe(thinking.type as string);
    }
    expect(requestThinkingType({ modelId: "m", messages: [] })).toBeUndefined();
  });

  test("read input_transformations and classify rejections", () => {
    expect(inputTransformations({ input_transformations: [{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }, "junk", { other: 1 }] }))
      .toEqual([{ type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" }, { type: "unknown" }]);
    expect(inputTransformations(undefined)).toEqual([]);
    const validation = Object.assign(new Error("thinking.adaptive.block_binding: Extra inputs are not permitted"), { name: "ValidationException" });
    expect(isReplayRejection(validation)).toBe(true);
    expect(rejectsBindingControls(validation)).toBe(true);
    expect(isReplayRejection(Object.assign(new Error("slow down"), { name: "ThrottlingException" }))).toBe(false);
    expect(rejectsBindingControls(Object.assign(new Error("messages.1.content.0: Invalid `signature` in `thinking` block"), { name: "ValidationException" }))).toBe(false);
  });
});
