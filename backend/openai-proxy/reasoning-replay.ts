/**
 * Reasoning replay in the OpenAI-compatible handler: decide whether a request
 * takes part, put stored reasoning back into it, and store the reasoning of its
 * response (see transform/reasoning-replay.ts for how blocks are chosen).
 *
 * Replay never fails a request: storage errors are logged and ignored, and a
 * request that Bedrock rejects is sent once more without what replay added.
 */
import type { ConverseCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { resolveReasoningProfile } from "@/shared/reasoning";
import { getReasoningReplayEnabled } from "../config-service";
import { loadReplayEntries, refreshReplayEntries, saveReplayEntry } from "../reasoning-replay-store";
import {
  applyReasoningReplay,
  conversationPrefixHashes,
  inputTransformations,
  messageLookupKey,
  planReasoningReplay,
  rejectsBindingControls,
  requestThinkingType,
  withThinkingBindingControls,
  type CapturedReasoning,
  type ReplayEntry,
  type ReplayStats,
} from "./transform/reasoning-replay";

/** After a model rejects the binding controls, leave them out for this long. */
const BINDING_RETRY_AFTER_MS = 60 * 60 * 1000;
const bindingRejectedUntil = new Map<string, number>();

export interface ReasoningReplay {
  /** The request with replayed reasoning and binding controls. */
  request: ConverseCommandInput;
  /** The request without them, sent once if Bedrock rejects `request`; null when nothing was added. */
  fallback: ConverseCommandInput | null;
  userId: string;
  modelId: string;
  requestId: string;
  /** Hash of the conversation the response follows; undefined when its reasoning cannot be stored. */
  prefixHash: string | undefined;
  /** Newest replayed entry, the predecessor of the response's reasoning. */
  lastEntryId: string | null;
  bindingControls: boolean;
  stats: ReplayStats;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return `${error.name}: ${error.message.replace(/\s+/g, " ").slice(0, 300)}`;
}

/**
 * Prepare reasoning replay for a request whose reasoning configuration is
 * final (before managed cache points). Returns null when the request does not
 * take part: replay is turned off, the model is not a Claude thinking model, or
 * thinking is off. Never throws: on an unexpected error the request goes out
 * without replay.
 */
export async function prepareReasoningReplay(params: {
  request: ConverseCommandInput;
  model: { modelId: string; reasoningMode: string | null };
  userId: string;
  requestId: string;
}): Promise<ReasoningReplay | null> {
  try {
    return await prepare(params);
  } catch (error) {
    console.error(`[OpenAI Proxy] Reasoning replay skipped: request=${params.requestId} error=${describeError(error)}`);
    return null;
  }
}

async function prepare(params: {
  request: ConverseCommandInput;
  model: { modelId: string; reasoningMode: string | null };
  userId: string;
  requestId: string;
}): Promise<ReasoningReplay | null> {
  const { request, model, userId, requestId } = params;
  const profile = resolveReasoningProfile(model.modelId, model.reasoningMode);
  if (profile.style !== "anthropic_adaptive" && profile.style !== "anthropic_budget") return null;
  const thinking = requestThinkingType(request);
  if (thinking !== "adaptive" && thinking !== "enabled") return null;
  if (!(await getReasoningReplayEnabled())) return null;

  const messages = request.messages ?? [];
  const prefixHashes = conversationPrefixHashes(request);
  const keys = [...new Set(messages.map(messageLookupKey).filter((key): key is string => key !== null))];
  let entries: ReplayEntry[] = [];
  let loadFailed = false;
  try {
    entries = await loadReplayEntries({ userId, modelId: model.modelId, keys });
  } catch (error) {
    loadFailed = true;
    console.error(`[OpenAI Proxy] Reasoning replay lookup failed: request=${requestId} error=${describeError(error)}`);
  }
  const plan = planReasoningReplay(messages, prefixHashes, entries);

  let replayed = plan.insertions.size > 0 ? { ...request, messages: applyReasoningReplay(messages, plan) } : request;
  const until = bindingRejectedUntil.get(model.modelId);
  const bindingControls = profile.preservedThinking === true && thinking === "adaptive" && (until === undefined || until <= Date.now());
  if (bindingControls) replayed = withThinkingBindingControls(replayed);

  if (plan.entryIds.length > 0) {
    void refreshReplayEntries(plan.entryIds).catch((error: unknown) => {
      console.error(`[OpenAI Proxy] Reasoning replay refresh failed: request=${requestId} error=${describeError(error)}`);
    });
  }

  const { stats } = plan;
  console.log(
    `[OpenAI Proxy] Reasoning replay: request=${requestId} model=${model.modelId} assistant_turns=${stats.assistantTurns} ` +
    `matched=${stats.matched} replayed_entries=${stats.replayedEntries} replayed_blocks=${stats.replayedBlocks} ` +
    `missing=${stats.assistantTurns - stats.matched} stale=${stats.stale} unchained=${stats.unchained} ` +
    `binding=${bindingControls ? "drop_block" : "off"}${loadFailed ? " lookup=failed" : ""}`,
  );

  return {
    request: replayed,
    fallback: replayed === request ? null : request,
    userId,
    modelId: model.modelId,
    requestId,
    // A request ending in an assistant message continues that message; its reasoning is not stored.
    prefixHash: messages.at(-1)?.role === "user" ? prefixHashes.at(-1) : undefined,
    lastEntryId: plan.lastEntryId,
    bindingControls,
    stats,
  };
}

/** Log a rejected request that is about to be sent again without replay. */
export function noteReplayRejection(replay: ReasoningReplay, error: unknown): void {
  console.warn(
    `[OpenAI Proxy] Reasoning replay rejected, retrying without it: request=${replay.requestId} model=${replay.modelId} ` +
    `replayed_blocks=${replay.stats.replayedBlocks} binding=${replay.bindingControls ? "drop_block" : "off"} error=${describeError(error)}`,
  );
  if (replay.bindingControls && rejectsBindingControls(error)) {
    bindingRejectedUntil.set(replay.modelId, Date.now() + BINDING_RETRY_AFTER_MS);
  }
}

/**
 * Log thinking blocks Bedrock reports it dropped or let through unchanged
 * (`input_transformations`). Returns true when the response's reasoning
 * should start a new chain, because the model did not read the blocks as sent.
 */
export function reportInputTransformations(replay: ReasoningReplay, additionalFields: unknown): boolean {
  const thinking = inputTransformations(additionalFields).filter((entry) => entry.type.startsWith("thinking_"));
  if (thinking.length === 0) return false;
  const reasons = new Map<string, number>();
  for (const entry of thinking) {
    const key = `${entry.type}:${entry.reason ?? "unknown"}`;
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  console.warn(
    `[OpenAI Proxy] Bedrock dropped replayed reasoning: request=${replay.requestId} model=${replay.modelId} blocks=${thinking.length} ` +
    `reasons=${[...reasons].map(([key, count]) => `${key}=${count}`).join(",")} ` +
    `paths=${thinking.slice(0, 10).map((entry) => entry.path ?? "?").join(",")}`,
  );
  return true;
}

/**
 * Store the response's reasoning so the next request can send it back. Never
 * throws. `replayUsed` is false when the response came from the fallback
 * request; its reasoning then followed no replayed block.
 */
export async function storeReasoning(
  replay: ReasoningReplay,
  capture: () => CapturedReasoning | null,
  outcome: { replayUsed: boolean; startsNewChain: boolean },
): Promise<void> {
  if (replay.prefixHash === undefined) return;
  const predecessorId = outcome.replayUsed && !outcome.startsNewChain ? replay.lastEntryId : null;
  try {
    const reasoning = capture();
    if (!reasoning) return;
    const id = await saveReplayEntry({
      userId: replay.userId,
      modelId: replay.modelId,
      requestId: replay.requestId,
      prefixHash: replay.prefixHash,
      predecessorId,
      reasoning,
    });
    if (id) {
      console.log(`[OpenAI Proxy] Reasoning stored: request=${replay.requestId} model=${replay.modelId} blocks=${reasoning.blocks.length} chained=${predecessorId !== null}`);
    } else {
      console.warn(`[OpenAI Proxy] Reasoning not stored (too large): request=${replay.requestId} model=${replay.modelId} blocks=${reasoning.blocks.length}`);
    }
  } catch (error) {
    console.error(`[OpenAI Proxy] Reasoning store failed: request=${replay.requestId} model=${replay.modelId} error=${describeError(error)}`);
  }
}
