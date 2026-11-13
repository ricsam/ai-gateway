import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";

// Verifies reasoning replay against real TimescaleDB: the migration (fresh and
// upgrade from the previous release), the store (user/model scoping, upsert,
// expiry, refresh, cleanup, cascade, exact payload round trips), the inference
// setting through the management API, and the OpenAI-compatible handler loop
// with real authentication, billing and storage and Bedrock replaced by
// fixtures. Run separately from bun test; only newly created databases change.
const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (permission to create temporary databases)");
const suffix = crypto.randomUUID().replaceAll("-", "");
const names = { fresh: `replay_fresh_${suffix}`, upgrade: `replay_upgrade_${suffix}` };
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/reasoning-replay-");
const priorFolder = join(scratch, "prior-migrations");
const manifest = { runId: suffix, databases: names, paths: [scratch, priorFolder], cleanedUp: false };
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
const admin = new Pool({ connectionString: adminUrl });
const created: string[] = [];
let applicationPool: Pool | undefined;
function databaseUrl(name: string) {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}
async function createDatabase(name: string) {
  await admin.query(`CREATE DATABASE "${name}"`);
  created.push(name);
}

const MODEL = "eu.anthropic.claude-opus-5-5";
const ENTRY_COLUMNS = ["id", "user_id", "model_id", "lookup_key", "prefix_hash", "predecessor_id", "request_id", "payload", "byte_size", "created_at", "expires_at"];

try {
  await createDatabase(names.fresh);
  const fresh = new Pool({ connectionString: databaseUrl(names.fresh) });
  try {
    await migrate(drizzle(fresh), { migrationsFolder: "drizzle" });
    const columns = await fresh.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reasoning_replay_entries' ORDER BY ordinal_position");
    assert.deepEqual(columns.rows.map((row) => row.column_name), ENTRY_COLUMNS);
  } finally { await fresh.end(); }

  // Upgrade a database built by the previous release's exact migration chain.
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const cutoff = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0007_reasoning_replay");
  assert.ok(cutoff > 0);
  const priorEntries = journal.entries.slice(0, cutoff) as Array<{ tag: string }>;
  await mkdir(join(priorFolder, "meta"), { recursive: true });
  await writeFile(join(priorFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }));
  for (const entry of priorEntries) await copyFile(`drizzle/${entry.tag}.sql`, join(priorFolder, `${entry.tag}.sql`));
  await createDatabase(names.upgrade);
  process.env.DATABASE_URL = databaseUrl(names.upgrade);
  process.env.BASE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.SETTINGS_ENCRYPTION_KEY = `v1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
  const { pool } = await import("../backend/db");
  applicationPool = pool;
  await migrate(drizzle(pool), { migrationsFolder: priorFolder });
  await pool.query("UPDATE application_settings SET revision = 3 WHERE id = 'main'");
  await pool.query(`INSERT INTO "user" (id, username, name, email, role, enabled, credit_balance, created_at, updated_at) VALUES
    ('admin', 'admin', 'Admin', 'admin@example.test', 'admin', true, 0, now(), now()),
    ('alice', 'alice', 'Alice', 'alice@example.test', 'user', true, 10, now(), now()),
    ('bob', 'bob', 'Bob', 'bob@example.test', 'user', true, 10, now(), now())`);
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  assert.deepEqual((await pool.query("SELECT revision, reasoning_replay_enabled FROM application_settings")).rows, [{ revision: 3, reasoning_replay_enabled: true }]);
  const upgradedColumns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reasoning_replay_entries' ORDER BY ordinal_position");
  assert.deepEqual(upgradedColumns.rows.map((row) => row.column_name), ENTRY_COLUMNS);

  const store = await import("../backend/reasoning-replay-store");
  const { getReasoningReplayEnabled } = await import("../backend/config-service");
  assert.equal(await getReasoningReplayEnabled(), true);
  const count = async (where = "true", params: unknown[] = []) => Number((await pool.query(`SELECT count(*) AS n FROM reasoning_replay_entries WHERE ${where}`, params)).rows[0].n);
  const expiresAt = async (id: string) => (await pool.query("SELECT expires_at FROM reasoning_replay_entries WHERE id = $1", [id])).rows[0].expires_at as Date;

  // Exact round trip, including strings jsonb could not hold.
  const tricky = `nul:\u0000 lone:\ud800 emoji:🧠 quote:" backslash:\\ ${"x".repeat(200_000)}`;
  const reasoning = {
    lookupKey: "tool:tooluse_store",
    blocks: [
      { position: 0, block: { type: "text" as const, text: tricky, signature: "c2lnbmF0dXJl/+=" } },
      { position: 1, block: { type: "redacted" as const, data: "AQID" } },
    ],
    visible: ["hash-1", "hash-2"],
  };
  const entry = (overrides: Partial<Parameters<typeof store.saveReplayEntry>[0]> = {}) => ({
    userId: "alice", modelId: MODEL, requestId: "request-1", prefixHash: "prefix-1", predecessorId: null, reasoning, ...overrides,
  });
  const first = await store.saveReplayEntry(entry());
  assert.ok(first);
  assert.deepEqual(await store.loadReplayEntries({ userId: "alice", modelId: MODEL, keys: ["tool:tooluse_store", "tool:unknown"] }), [
    { id: first, lookupKey: reasoning.lookupKey, prefixHash: "prefix-1", predecessorId: null, blocks: reasoning.blocks, visible: reasoning.visible },
  ]);
  assert.deepEqual(await store.loadReplayEntries({ userId: "bob", modelId: MODEL, keys: [reasoning.lookupKey] }), [], "never across users");
  assert.deepEqual(await store.loadReplayEntries({ userId: "alice", modelId: "eu.anthropic.claude-sonnet-5-5", keys: [reasoning.lookupKey] }), [], "never across models");
  assert.deepEqual(await store.loadReplayEntries({ userId: "alice", modelId: MODEL, keys: [] }), []);

  // A later response with the same key replaces the entry under a new ID.
  const replaced = await store.saveReplayEntry(entry({ prefixHash: "prefix-2", predecessorId: first, requestId: "request-2" }));
  assert.ok(replaced && replaced !== first);
  const [current] = await store.loadReplayEntries({ userId: "alice", modelId: MODEL, keys: [reasoning.lookupKey] });
  assert.deepEqual([current?.id, current?.prefixHash, current?.predecessorId], [replaced, "prefix-2", first]);
  assert.equal(await count("user_id = 'alice'"), 1);
  await store.saveReplayEntry(entry({ userId: "bob" }));
  assert.equal(await count(), 2, "the same key of another user is a separate entry");

  // Expired entries are never loaded, and cleanup deletes only them.
  await pool.query("UPDATE reasoning_replay_entries SET expires_at = now() - interval '1 second' WHERE id = $1", [replaced]);
  assert.deepEqual(await store.loadReplayEntries({ userId: "alice", modelId: MODEL, keys: [reasoning.lookupKey] }), []);
  assert.equal(await store.deleteExpiredReplayEntries(), 1);
  assert.equal(await count(), 1);

  // Replays extend the life of an entry at most once a day.
  const refreshed = (await store.saveReplayEntry(entry({ reasoning: { ...reasoning, lookupKey: "text:refresh" } })))!;
  const createdExpiry = await expiresAt(refreshed);
  assert.ok(createdExpiry.getTime() - Date.now() > store.REASONING_REPLAY_TTL_MS - 60_000);
  await store.refreshReplayEntries([refreshed]);
  assert.equal((await expiresAt(refreshed)).getTime(), createdExpiry.getTime(), "a fresh entry is not rewritten");
  await pool.query("UPDATE reasoning_replay_entries SET expires_at = now() + interval '2 days' WHERE id = $1", [refreshed]);
  await store.refreshReplayEntries([refreshed]);
  assert.ok((await expiresAt(refreshed)).getTime() - Date.now() > store.REASONING_REPLAY_TTL_MS - 60_000);

  // Oversized responses are not stored; deleting a user deletes their entries.
  assert.equal(await store.saveReplayEntry(entry({ reasoning: { ...reasoning, lookupKey: "tool:huge", blocks: [{ position: 0, block: { type: "text", text: "x".repeat(store.MAX_REASONING_ENTRY_BYTES), signature: "s" } }] } })), null);
  await pool.query(`DELETE FROM "user" WHERE id = 'bob'`);
  assert.equal(await count("user_id = 'bob'"), 0);

  // The inference setting, and its purge, through the management API.
  const { hashApiKey } = await import("../backend/api-key-utils");
  const { handleManagementApi } = await import("../backend/management-api");
  const managementKey = `aigm_${suffix}`;
  await pool.query("INSERT INTO management_api_keys (id, name, key_hash, key_prefix, scopes, created_by_user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
    ["management", "Verify", await hashApiKey(managementKey), managementKey.slice(0, 13), ["settings.read", "settings.write"], "admin"]);
  async function management(path: string, method = "GET", data?: unknown, status = 200) {
    const response = await handleManagementApi(new Request(`http://localhost:3000/management/v1${path}`, {
      method, headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data),
    }));
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return response.json() as Promise<any>;
  }
  const settings = (await management("/settings")).data;
  assert.deepEqual(settings, { revision: 3, remoteImageUrlsEnabled: true, reasoningReplayEnabled: true });
  await management("/settings", "PUT", { revision: 3, reasoningReplayEnabled: "no" }, 400);
  assert.ok(await count() > 0);
  const disabled = (await management("/settings", "PUT", { revision: 3, reasoningReplayEnabled: false })).data;
  assert.deepEqual(disabled, { revision: 4, remoteImageUrlsEnabled: true, reasoningReplayEnabled: false });
  assert.equal(await count(), 0, "turning replay off deletes stored reasoning");
  assert.equal(await getReasoningReplayEnabled(), false);
  const audit = await pool.query("SELECT metadata FROM audit_events WHERE action = 'settings.updated' ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual(audit.rows[0].metadata, { reasoningReplayEnabled: false, reasoningEntriesDeleted: 1 });
  assert.deepEqual((await management("/settings", "PUT", { revision: 4, reasoningReplayEnabled: true })).data, { revision: 5, remoteImageUrlsEnabled: true, reasoningReplayEnabled: true });

  // The OpenAI-compatible handler with real authentication, billing and storage.
  const { encryptSetting } = await import("../backend/settings-crypto");
  await pool.query("UPDATE aws_configuration SET default_region = 'eu-central-1', access_key_id = 'AKIAVERIFYREPLAY', secret_access_key_envelope = $1, updated_at = now() WHERE id = 'main'",
    [await encryptSetting("not-a-real-secret", "aws:secret-access-key")]);
  await pool.query("INSERT INTO models (id, model_id, name, input_price_per_m_tok, output_price_per_m_tok, max_output_tokens, thinking, enabled, created_at, updated_at) VALUES ('opus', $1, 'Opus 5.5', 5, 25, 64000, true, true, now(), now())", [MODEL]);
  const inferenceKey = `aig_${suffix}`;
  await pool.query("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at) VALUES ('alice-key', 'alice', 'Alice', $1, $2, now())", [await hashApiKey(inferenceKey), inferenceKey.slice(0, 13)]);

  const sentToBedrock: Array<{ streaming: boolean; input: ConverseCommandInput }> = [];
  let step = 0;
  // Bedrock fixtures: each call answers with one signed thinking block, text and a tool call.
  BedrockRuntimeClient.prototype.send = async function (command: unknown) {
    const streaming = command instanceof ConverseStreamCommand;
    if (!streaming && !(command instanceof ConverseCommand)) throw new Error("unexpected Bedrock command");
    const input = (command as ConverseCommand).input;
    sentToBedrock.push({ streaming, input });
    step++;
    const toolUseId = `tooluse_${step}`;
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
    if (!streaming) {
      const content: ContentBlock[] = [
        { reasoningContent: { reasoningText: { text: `Thinking ${step}.`, signature: `sig-${step}` } } },
        { reasoningContent: { redactedContent: new Uint8Array([step, 9, 9]) } },
        { text: "Checking." },
        { toolUse: { toolUseId, name: "weather", input: { city: "Stockholm" } } },
      ];
      return { output: { message: { role: "assistant", content } }, stopReason: "tool_use", usage, additionalModelResponseFields: { input_transformations: [] } };
    }
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: `Thinking ${step}.` } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: `sig-${step}` } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "Checking." } } },
      { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId, name: "weather" } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: "{\"city\":\"Stockholm\"}" } } } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage } },
    ];
    return { stream: (async function* () { for (const event of events) yield event; })() };
  } as typeof BedrockRuntimeClient.prototype.send;

  const { handleOpenAIProxy } = await import("../backend/openai-proxy/handler");
  const question = { role: "user", content: "What is the weather in Stockholm?" };
  const tools = [{ type: "function", function: { name: "weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
  const history: unknown[] = [question];
  async function chat(stream: boolean) {
    const response = await handleOpenAIProxy(new Request("http://localhost:3000/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${inferenceKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, stream, reasoning_effort: "max", tools, messages: history }),
    }));
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const toolUseId = `tooluse_${step}`;
    history.push(
      { role: "assistant", content: "Checking.", tool_calls: [{ id: toolUseId, type: "function", function: { name: "weather", arguments: "{\"city\":\"Stockholm\"}" } }] },
      { role: "tool", tool_call_id: toolUseId, content: "{\"temperature\":18}" },
    );
  }
  const reasoningSent = (index: number) => (sentToBedrock[index]!.input.messages ?? []).flatMap((message) => (message.content ?? []).flatMap((block) =>
    block.reasoningContent?.reasoningText ? [block.reasoningContent.reasoningText.signature] : block.reasoningContent?.redactedContent ? [`redacted:${[...block.reasoningContent.redactedContent].join(".")}`] : []));
  const rows = async () => (await pool.query("SELECT id, lookup_key, predecessor_id FROM reasoning_replay_entries WHERE user_id = 'alice' AND model_id = $1 ORDER BY created_at", [MODEL])).rows;

  await chat(true);
  assert.deepEqual(reasoningSent(0), []);
  assert.deepEqual((sentToBedrock[0]!.input.additionalModelRequestFields as Record<string, unknown>).anthropic_beta, ["thinking-binding-controls-2026-08-01"]);
  const afterFirst = await rows();
  assert.deepEqual(afterFirst.map((row) => [row.lookup_key, row.predecessor_id]), [["tool:tooluse_1", null]]);

  await chat(false);
  assert.deepEqual(reasoningSent(1), ["sig-1"]);
  const afterSecond = await rows();
  assert.deepEqual(afterSecond.map((row) => [row.lookup_key, row.predecessor_id]), [["tool:tooluse_1", null], ["tool:tooluse_2", afterFirst[0].id]]);

  await chat(true);
  assert.deepEqual(reasoningSent(2), ["sig-1", "sig-2", "redacted:2.9.9"]);
  const assistantTurn = sentToBedrock[2]!.input.messages![3]!.content!;
  assert.deepEqual(assistantTurn.map((block) => Object.keys(block)[0]), ["reasoningContent", "reasoningContent", "text", "toolUse"], "reasoning stays first in its turn");
  assert.equal((await rows()).at(-1)!.predecessor_id, afterSecond[1].id);
  const billed = await pool.query("SELECT count(*) AS n FROM credit_events WHERE user_id = 'alice'");
  assert.equal(Number(billed.rows[0].n), 3);

  // Another user replays nothing from Alice's conversation.
  const bobKey = `aig_bob_${suffix}`;
  await pool.query(`INSERT INTO "user" (id, username, name, email, credit_balance, created_at, updated_at) VALUES ('carol', 'carol', 'Carol', 'carol@example.test', 10, now(), now())`);
  await pool.query("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, created_at) VALUES ('carol-key', 'carol', 'Carol', $1, $2, now())", [await hashApiKey(bobKey), bobKey.slice(0, 13)]);
  const other = await handleOpenAIProxy(new Request("http://localhost:3000/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${bobKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, reasoning_effort: "max", tools, messages: history }),
  }));
  assert.equal(other.status, 200, await other.clone().text());
  assert.deepEqual(reasoningSent(3), []);

  console.log("Reasoning replay verification passed: fresh + upgrade migrations, store scoping/upsert/expiry/refresh/cleanup/cascade/size limit, exact payload round trip, settings toggle with purge and audit, and a three-step handler loop (streaming and non-streaming) with real auth, billing and storage.");
} finally {
  await applicationPool?.end();
  try {
    for (const name of created) await admin.query(`DROP DATABASE "${name}"`);
    await rm(priorFolder, { recursive: true, force: true });
    manifest.cleanedUp = true;
    await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  } finally { await admin.end(); }
  console.log(`Resource manifest: ${scratch}/manifest.json`);
}
