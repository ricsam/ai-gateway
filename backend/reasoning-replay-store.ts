/**
 * Postgres storage for replayed Claude reasoning (see
 * openai-proxy/transform/reasoning-replay.ts). Entries live for days rather
 * than minutes, because sessions resume after breaks, and each replay extends
 * the life of the entries it uses.
 */
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import db from "./db";
import { reasoningReplayEntriesTable } from "./schema";
import type { CapturedReasoning, PositionedReasoningBlock, ReplayEntry } from "./openai-proxy/transform/reasoning-replay";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Entries expire after this long without being replayed. */
export const REASONING_REPLAY_TTL_MS = 7 * DAY_MS;
/** Replays extend an entry's life at most once a day. */
const REFRESH_INTERVAL_MS = DAY_MS;
/** Larger responses are not stored (a large max-effort step is well under 1 MB). */
export const MAX_REASONING_ENTRY_BYTES = 16 * 1024 * 1024;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_BATCH = 500;

interface Payload {
  v: 1;
  blocks: PositionedReasoningBlock[];
  visible: string[];
}

function isPositionedBlock(value: unknown): value is PositionedReasoningBlock {
  if (typeof value !== "object" || value === null) return false;
  const { position, block } = value as { position?: unknown; block?: Record<string, unknown> };
  if (typeof position !== "number" || typeof block !== "object" || block === null) return false;
  if (block.type === "text") return typeof block.text === "string" && typeof block.signature === "string";
  return block.type === "redacted" && typeof block.data === "string";
}

function parsePayload(payload: string): Payload | null {
  try {
    const value = JSON.parse(payload) as Partial<Payload>;
    if (value.v !== 1 || !Array.isArray(value.blocks) || !Array.isArray(value.visible)) return null;
    if (!value.blocks.every(isPositionedBlock) || !value.visible.every((hash) => typeof hash === "string")) return null;
    return value as Payload;
  } catch {
    return null;
  }
}

/** Unexpired entries of one user and upstream model for the given lookup keys. */
export async function loadReplayEntries(params: { userId: string; modelId: string; keys: readonly string[] }): Promise<ReplayEntry[]> {
  if (params.keys.length === 0) return [];
  const table = reasoningReplayEntriesTable;
  const rows = await db.select({
    id: table.id,
    lookupKey: table.lookupKey,
    prefixHash: table.prefixHash,
    predecessorId: table.predecessorId,
    payload: table.payload,
  }).from(table).where(and(
    eq(table.userId, params.userId),
    eq(table.modelId, params.modelId),
    inArray(table.lookupKey, [...new Set(params.keys)]),
    gt(table.expiresAt, new Date()),
  ));
  return rows.flatMap((row) => {
    const payload = parsePayload(row.payload);
    if (!payload) return [];
    return [{ id: row.id, lookupKey: row.lookupKey, prefixHash: row.prefixHash, predecessorId: row.predecessorId, blocks: payload.blocks, visible: payload.visible }];
  });
}

export interface NewReplayEntry {
  userId: string;
  modelId: string;
  requestId: string;
  prefixHash: string;
  predecessorId: string | null;
  reasoning: CapturedReasoning;
}

/**
 * Store a response's reasoning. A later response with the same lookup key (the
 * same answer text) replaces the earlier one under a new ID. Returns the new
 * entry ID, or null when the entry is too large to store.
 */
export async function saveReplayEntry(entry: NewReplayEntry, now = new Date()): Promise<string | null> {
  const payload = JSON.stringify({ v: 1, blocks: entry.reasoning.blocks, visible: entry.reasoning.visible } satisfies Payload);
  const byteSize = Buffer.byteLength(payload);
  if (byteSize > MAX_REASONING_ENTRY_BYTES) return null;
  const id = crypto.randomUUID();
  const values = {
    id,
    prefixHash: entry.prefixHash,
    predecessorId: entry.predecessorId,
    requestId: entry.requestId,
    payload,
    byteSize,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REASONING_REPLAY_TTL_MS),
  };
  const table = reasoningReplayEntriesTable;
  await db.insert(table)
    .values({ ...values, userId: entry.userId, modelId: entry.modelId, lookupKey: entry.reasoning.lookupKey })
    .onConflictDoUpdate({ target: [table.userId, table.modelId, table.lookupKey], set: values });
  return id;
}

/** Extend the life of replayed entries, writing each at most once a day. */
export async function refreshReplayEntries(ids: readonly string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  const table = reasoningReplayEntriesTable;
  const expiresAt = new Date(now.getTime() + REASONING_REPLAY_TTL_MS);
  await db.update(table).set({ expiresAt }).where(and(
    inArray(table.id, [...ids]),
    lt(table.expiresAt, new Date(expiresAt.getTime() - REFRESH_INTERVAL_MS)),
  ));
}

/** Delete expired entries in small batches; returns how many were deleted. */
export async function deleteExpiredReplayEntries(): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < 200; batch++) {
    const result = await db.executeRaw(
      "DELETE FROM reasoning_replay_entries WHERE id IN (SELECT id FROM reasoning_replay_entries WHERE expires_at < now() LIMIT $1)",
      [CLEANUP_BATCH],
    );
    deleted += result.rowCount;
    if (result.rowCount < CLEANUP_BATCH) break;
  }
  return deleted;
}

/** Periodically delete expired entries (queries already ignore them). */
export function startReasoningReplayCleanup() {
  const run = () => void deleteExpiredReplayEntries()
    .then((deleted) => { if (deleted > 0) console.log(`[reasoning-replay] Deleted ${deleted} expired entries`); })
    .catch((error: unknown) => console.error("[reasoning-replay] Cleanup failed:", error instanceof Error ? error.message : error));
  const first = setTimeout(run, 60_000);
  const interval = setInterval(run, CLEANUP_INTERVAL_MS);
  return { stop() { clearTimeout(first); clearInterval(interval); } };
}
