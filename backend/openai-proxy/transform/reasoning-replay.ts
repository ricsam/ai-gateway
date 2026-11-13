/**
 * Reasoning replay: keep Claude's earlier thinking in the conversation.
 *
 * OpenAI-format clients never receive thinking signatures, so they cannot send
 * Claude's reasoning back. The gateway captures the reasoning blocks of each
 * response (text with its signature, or redacted content), stores them, and puts
 * them back unmodified, in their original positions, into the matching assistant
 * turns of later requests.
 *
 * Claude binds a thinking block to what preceded it when it was produced:
 * - the non-thinking prefix: the system prompt, the tools, every earlier
 *   message and the earlier blocks of its own message must be unchanged;
 * - its previous thinking block: each replayed block except the first must
 *   follow the same thinking block as when it was produced. Blocks may be left
 *   out from the oldest end, but a gap in the middle invalidates later blocks.
 *
 * So each stored entry records a hash of the conversation before the response
 * (`prefixHash`) and the entry whose thinking was the last one replayed in the
 * request that produced it (`predecessorId`). Replay takes the newest entry
 * whose conversation is unchanged and follows its predecessors back for as long
 * as they are stored and unchanged too. Requests built this way only carry
 * blocks Claude can use, so the prompt cache keeps hitting from turn to turn.
 *
 * Replay works on the Bedrock messages after same-role consolidation, so an
 * assistant turn that a client split into several messages is matched (and its
 * reasoning placed) as the one response it was.
 *
 * Everything here is pure; the handler loads and saves entries.
 */
import { createHash } from "node:crypto";
import type {
  ContentBlock,
  ContentBlockDelta,
  ConverseCommandInput,
  Message,
  ReasoningContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { parseToolArguments } from "./request";

/** A reasoning block exactly as Claude produced it. */
export type StoredReasoningBlock =
  | { type: "text"; text: string; signature: string }
  /** Encrypted reasoning, base64-encoded. */
  | { type: "redacted"; data: string };

export interface PositionedReasoningBlock {
  /** Number of visible (text or tool use) blocks before this block in its response. */
  position: number;
  block: StoredReasoningBlock;
}

/** Reasoning captured from one response, before it is stored. */
export interface CapturedReasoning {
  /** `tool:<first tool call ID>` or `text:<sha256 of the text the client received>`. */
  lookupKey: string;
  blocks: PositionedReasoningBlock[];
  /** Hashes of the response's visible blocks, in order. */
  visible: string[];
}

/** A stored response whose reasoning can be replayed. */
export interface ReplayEntry extends CapturedReasoning {
  id: string;
  /** Hash of the system prompt, tools and turns of the request that produced the response. */
  prefixHash: string;
  /** Entry whose reasoning was the last one replayed in that request. */
  predecessorId: string | null;
}

export interface ReplayStats {
  /** Assistant messages in the request. */
  assistantTurns: number;
  /** Stored entries found for those messages. */
  matched: number;
  /** Found entries whose earlier conversation or own message changed since they were stored. */
  stale: number;
  /** Unchanged entries left out because the chain to the newest entry broke before them. */
  unchained: number;
  replayedEntries: number;
  replayedBlocks: number;
}

export interface ReplayPlan {
  /** Message index → that message's content with its reasoning put back. */
  insertions: Map<number, ContentBlock[]>;
  /** Replayed entries, oldest first. */
  entryIds: string[];
  /** Newest replayed entry: the predecessor of the reasoning the request produces. */
  lastEntryId: string | null;
  stats: ReplayStats;
}

export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
export const INPUT_TRANSFORMATIONS_PATH = "/input_transformations";
const PREFIX_HASH_VERSION = "ai-gateway:reasoning-prefix:v1";
/** Longer client-supplied tool call IDs are hashed into the lookup key. */
const MAX_TOOL_ID_KEY_LENGTH = 200;

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Deterministic JSON: sorted keys, undefined skipped, bytes replaced by their digest. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Uint8Array) return `{"$bytes":"${sha256(value)}"}`;
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      const record = value as Fields;
      const members = Object.keys(record).sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      return "null";
  }
}

function withoutCachePoints<T extends object>(blocks: readonly T[] | undefined): T[] {
  return (blocks ?? []).filter((block) => (block as { cachePoint?: unknown }).cachePoint === undefined);
}

/** Content Claude's prefix check compares: everything except thinking and cache points. */
function comparedContent(content: readonly ContentBlock[]): ContentBlock[] {
  return content.filter((block) => block.reasoningContent === undefined && block.cachePoint === undefined);
}

/**
 * Hashes of the conversation before each message: `hashes[i]` covers the
 * system prompt, the tools and messages `0..i-1`; the last one covers the whole
 * request. Thinking blocks and cache points are left out, as in Claude's
 * prefix check.
 */
export function conversationPrefixHashes(request: Pick<ConverseCommandInput, "system" | "toolConfig" | "messages">): string[] {
  let current = sha256(`${PREFIX_HASH_VERSION}\n${canonicalJson({
    system: withoutCachePoints(request.system),
    tools: withoutCachePoints(request.toolConfig?.tools),
  })}`);
  const hashes = [current];
  for (const message of request.messages ?? []) {
    current = sha256(`${current}\n${canonicalJson({ role: message.role, content: comparedContent(message.content ?? []) })}`);
    hashes.push(current);
  }
  return hashes;
}

function toolKey(id: string): string {
  return id.length <= MAX_TOOL_ID_KEY_LENGTH ? `tool:${id}` : `tool-sha256:${sha256(id)}`;
}

function textKey(text: string): string {
  return `text:${sha256(text)}`;
}

/** Key of the stored response behind an assistant message: its first tool call ID, else its text. */
export function messageLookupKey(message: Message): string | null {
  if (message.role !== "assistant") return null;
  const content = message.content ?? [];
  for (const block of content) {
    if (block.toolUse?.toolUseId) return toolKey(block.toolUse.toolUseId);
  }
  const text = content.map((block) => block.text ?? "").join("");
  return text ? textKey(text) : null;
}

function isVisibleBlock(block: ContentBlock): boolean {
  if (block.reasoningContent !== undefined || block.cachePoint !== undefined) return false;
  return block.text === undefined || block.text.length > 0;
}

function visibleBlockHash(block: ContentBlock): string {
  if (block.text !== undefined) return sha256(canonicalJson({ text: block.text }));
  if (block.toolUse) {
    const { toolUseId, name, input } = block.toolUse;
    return sha256(canonicalJson({ toolUse: { toolUseId, name, input } }));
  }
  return sha256(canonicalJson(block));
}

/** The tool use block a client message holds after sending back a tool call with these arguments. */
function echoedToolUse(toolUseId: string, name: string, args: string): ContentBlock {
  return { toolUse: { toolUseId, name, input: parseToolArguments(args).value as ContentBlock.ToolUseMember["toolUse"]["input"] } };
}

export function toReasoningContentBlock(block: StoredReasoningBlock): ContentBlock {
  return block.type === "text"
    ? { reasoningContent: { reasoningText: { text: block.text, signature: block.signature } } }
    : { reasoningContent: { redactedContent: Uint8Array.from(Buffer.from(block.data, "base64")) } };
}

function storedReasoningBlock(reasoning: ReasoningContentBlock): StoredReasoningBlock | null {
  if (reasoning.reasoningText) {
    const { text, signature } = reasoning.reasoningText;
    // Without a signature the block cannot be sent back.
    return signature ? { type: "text", text: text ?? "", signature } : null;
  }
  if (reasoning.redactedContent) return { type: "redacted", data: Buffer.from(reasoning.redactedContent).toString("base64") };
  return null;
}

function captured(lookupKey: string | null, blocks: PositionedReasoningBlock[], visible: string[]): CapturedReasoning | null {
  return lookupKey && blocks.length > 0 ? { lookupKey, blocks, visible } : null;
}

/**
 * Capture the reasoning of a non-streaming Converse response. `message` is the
 * OpenAI message the client receives, which supplies the tool call IDs and text
 * the client sends back. Returns null when there is nothing to replay or a
 * reasoning block cannot be replayed (a missing signature or an unknown form).
 */
export function captureConverseReasoning(
  content: readonly ContentBlock[],
  message: { content: string | null; tool_calls?: ReadonlyArray<{ id: string }> },
): CapturedReasoning | null {
  const blocks: PositionedReasoningBlock[] = [];
  const visible: string[] = [];
  let toolIndex = 0;
  let firstToolId: string | undefined;
  for (const block of content) {
    if (block.reasoningContent !== undefined) {
      const stored = storedReasoningBlock(block.reasoningContent);
      if (!stored) return null;
      blocks.push({ position: visible.length, block: stored });
    } else if (block.toolUse) {
      const id = message.tool_calls?.[toolIndex++]?.id ?? block.toolUse.toolUseId ?? "";
      firstToolId ??= id;
      visible.push(visibleBlockHash(echoedToolUse(id, block.toolUse.name ?? "", JSON.stringify(block.toolUse.input ?? {}))));
    } else if (block.text !== undefined) {
      if (block.text) visible.push(visibleBlockHash({ text: block.text }));
    } else {
      // Blocks the client never receives cannot match a message it sends back.
      visible.push(visibleBlockHash(block));
    }
  }
  return captured(firstToolId ? toolKey(firstToolId) : message.content ? textKey(message.content) : null, blocks, visible);
}

type PendingBlock =
  | { kind: "text"; text: string }
  | { kind: "toolUse"; id: string; name: string; input: string }
  | { kind: "reasoning"; text: string; signature: string; redacted: Uint8Array[] }
  | { kind: "other" };

/** Collects the content blocks of a ConverseStream response as they arrive. */
export class StreamingReasoningCapture {
  private readonly blocks = new Map<number, PendingBlock>();
  private text = "";
  private sawReasoning = false;

  /** A tool call started; `toolUseId` is the ID the client received. */
  toolUseStart(index: number, toolUseId: string, name: string): void {
    this.blocks.set(index, { kind: "toolUse", id: toolUseId, name, input: "" });
  }

  delta(index: number, delta: ContentBlockDelta | undefined): void {
    if (!delta) return;
    const block = this.blocks.get(index);
    if (delta.text !== undefined) {
      // The client receives every text delta, concatenated, as `content`.
      this.text += delta.text;
      if (!block) this.blocks.set(index, { kind: "text", text: delta.text });
      else if (block.kind === "text") block.text += delta.text;
      else this.blocks.set(index, { kind: "other" });
    } else if (delta.toolUse) {
      if (block?.kind === "toolUse") block.input += delta.toolUse.input ?? "";
      else this.blocks.set(index, { kind: "other" });
    } else if (delta.reasoningContent) {
      this.sawReasoning = true;
      const reasoning = block ?? { kind: "reasoning", text: "", signature: "", redacted: [] };
      if (reasoning.kind !== "reasoning") {
        this.blocks.set(index, { kind: "other" });
        return;
      }
      this.blocks.set(index, reasoning);
      const part = delta.reasoningContent;
      if (part.text !== undefined) reasoning.text += part.text;
      else if (part.signature !== undefined) reasoning.signature += part.signature;
      else if (part.redactedContent !== undefined) reasoning.redacted.push(part.redactedContent);
      else this.blocks.set(index, { kind: "other" });
    } else if (!block) {
      this.blocks.set(index, { kind: "other" });
    }
  }

  /** The captured reasoning once the message is complete, or null when there is nothing to replay. */
  finish(): CapturedReasoning | null {
    if (!this.sawReasoning) return null;
    const blocks: PositionedReasoningBlock[] = [];
    const visible: string[] = [];
    let firstToolId: string | undefined;
    for (const [, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      switch (block.kind) {
        case "reasoning": {
          if (block.redacted.length > 0) {
            if (block.text || block.signature) return null;
            blocks.push({ position: visible.length, block: { type: "redacted", data: Buffer.concat(block.redacted).toString("base64") } });
          } else if (block.signature) {
            blocks.push({ position: visible.length, block: { type: "text", text: block.text, signature: block.signature } });
          } else {
            // An unsigned block (an interrupted stream) cannot be sent back.
            return null;
          }
          break;
        }
        case "toolUse":
          firstToolId ??= block.id;
          visible.push(visibleBlockHash(echoedToolUse(block.id, block.name, block.input)));
          break;
        case "text":
          if (block.text) visible.push(visibleBlockHash({ text: block.text }));
          break;
        case "other":
          // Never matches a message the client sends back.
          visible.push(sha256(`other:${visible.length}`));
          break;
      }
    }
    return captured(firstToolId ? toolKey(firstToolId) : this.text ? textKey(this.text) : null, blocks, visible);
  }
}

/**
 * Put an entry's reasoning back into the message the client sent, or return
 * null when a block would follow content that changed since it was produced.
 */
function placeReasoning(content: readonly ContentBlock[], entry: CapturedReasoning): ContentBlock[] | null {
  const visible = content.filter(isVisibleBlock).map(visibleBlockHash);
  let unchanged = 0;
  while (unchanged < visible.length && unchanged < entry.visible.length && visible[unchanged] === entry.visible[unchanged]) unchanged++;
  const blocks = [...entry.blocks].sort((a, b) => a.position - b.position);
  if (blocks.some(({ position }) => !Number.isInteger(position) || position < 0 || position > unchanged)) return null;

  const result: ContentBlock[] = [];
  let next = 0;
  let visibleIndex = 0;
  for (const block of content) {
    if (isVisibleBlock(block)) {
      while (next < blocks.length && blocks[next]!.position === visibleIndex) result.push(toReasoningContentBlock(blocks[next++]!.block));
      visibleIndex++;
    }
    result.push(block);
  }
  while (next < blocks.length) result.push(toReasoningContentBlock(blocks[next++]!.block));
  return result;
}

interface UsableEntry {
  entry: ReplayEntry;
  messageIndex: number;
  /** The message's content with the entry's reasoning put back. */
  content: ContentBlock[];
}

/**
 * Choose the reasoning to replay into a request's (consolidated) messages.
 * `prefixHashes` come from conversationPrefixHashes for the same messages;
 * `entries` are the stored entries found for the messages' lookup keys (same
 * user and upstream model only).
 */
export function planReasoningReplay(
  messages: readonly Message[],
  prefixHashes: readonly string[],
  entries: readonly ReplayEntry[],
): ReplayPlan {
  const byKey = new Map(entries.map((entry) => [entry.lookupKey, entry]));
  // An entry belongs to the last message that matches it (a repeated identical answer).
  const matches = new Map<string, { entry: ReplayEntry; messageIndex: number }>();
  let assistantTurns = 0;
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    assistantTurns++;
    const key = messageLookupKey(message);
    const entry = key ? byKey.get(key) : undefined;
    if (entry) matches.set(entry.id, { entry, messageIndex });
  });

  const usable = new Map<string, UsableEntry>();
  let stale = 0;
  for (const { entry, messageIndex } of matches.values()) {
    const content = entry.prefixHash === prefixHashes[messageIndex]
      ? placeReasoning(messages[messageIndex]!.content ?? [], entry)
      : null;
    if (content) usable.set(entry.id, { entry, messageIndex, content });
    else stale++;
  }

  // Follow the chain back from the newest usable entry. Earlier entries off the
  // chain were not in the conversation when its blocks were produced.
  let current: UsableEntry | undefined;
  for (const candidate of usable.values()) {
    if (!current || candidate.messageIndex > current.messageIndex) current = candidate;
  }
  const chain: UsableEntry[] = [];
  while (current) {
    chain.unshift(current);
    const messageIndex: number = current.messageIndex;
    const previous: UsableEntry | undefined = current.entry.predecessorId ? usable.get(current.entry.predecessorId) : undefined;
    current = previous && previous.messageIndex < messageIndex ? previous : undefined;
  }

  return {
    insertions: new Map(chain.map(({ messageIndex, content }) => [messageIndex, content])),
    entryIds: chain.map(({ entry }) => entry.id),
    lastEntryId: chain.at(-1)?.entry.id ?? null,
    stats: {
      assistantTurns,
      matched: matches.size,
      stale,
      unchained: usable.size - chain.length,
      replayedEntries: chain.length,
      replayedBlocks: chain.reduce((total, { entry }) => total + entry.blocks.length, 0),
    },
  };
}

/** The request's messages with the planned reasoning put back. */
export function applyReasoningReplay(messages: readonly Message[], plan: ReplayPlan): Message[] {
  return messages.map((message, index) => {
    const content = plan.insertions.get(index);
    return content ? { ...message, content } : message;
  });
}

/** The request's `thinking.type`, if it sets one. */
export function requestThinkingType(request: ConverseCommandInput): string | undefined {
  const fields = request.additionalModelRequestFields;
  const thinking = isObject(fields) ? fields.thinking : undefined;
  return isObject(thinking) && typeof thinking.type === "string" ? thinking.type : undefined;
}

/**
 * Ask Claude to drop, rather than reject, replayed thinking whose conversation
 * changed, and to report what it dropped. Only for adaptive thinking on models
 * with preserved thinking; other configurations reject `block_binding`.
 */
export function withThinkingBindingControls(request: ConverseCommandInput): ConverseCommandInput {
  const fields: Fields = isObject(request.additionalModelRequestFields) ? { ...request.additionalModelRequestFields } : {};
  const thinking = fields.thinking;
  if (!isObject(thinking) || thinking.type !== "adaptive") return request;
  const betas = Array.isArray(fields.anthropic_beta) ? fields.anthropic_beta.filter((beta): beta is string => typeof beta === "string") : [];
  fields.anthropic_beta = betas.includes(THINKING_BINDING_BETA) ? betas : [...betas, THINKING_BINDING_BETA];
  fields.thinking = { ...thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } };
  const paths = request.additionalModelResponseFieldPaths ?? [];
  return {
    ...request,
    additionalModelRequestFields: fields as ConverseCommandInput["additionalModelRequestFields"],
    additionalModelResponseFieldPaths: paths.includes(INPUT_TRANSFORMATIONS_PATH) ? paths : [...paths, INPUT_TRANSFORMATIONS_PATH],
  };
}

export interface InputTransformation {
  type: string;
  path?: string;
  reason?: string;
}

/** `input_transformations` reported in a response's additional model response fields. */
export function inputTransformations(additionalFields: unknown): InputTransformation[] {
  const list = isObject(additionalFields) ? additionalFields.input_transformations : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(isObject).map((entry) => ({
    type: typeof entry.type === "string" ? entry.type : "unknown",
    ...(typeof entry.path === "string" && { path: entry.path }),
    ...(typeof entry.reason === "string" && { reason: entry.reason }),
  }));
}

/**
 * Whether Bedrock rejected the request as invalid. A request that carries
 * replayed reasoning or binding controls is then sent again without them, so
 * replay never fails a request that would succeed without it.
 */
export function isReplayRejection(error: unknown): boolean {
  return error instanceof Error && error.name === "ValidationException";
}

/** Whether a rejection names the thinking binding controls themselves. */
export function rejectsBindingControls(error: unknown): boolean {
  return error instanceof Error && /block_binding|thinking-binding-controls/i.test(error.message);
}
