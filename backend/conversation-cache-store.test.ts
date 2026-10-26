import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import type { ConversationBoundaryStore } from "./conversation-cache-types";

// Explicit opt-in only: never connect to the application's DATABASE_URL.
const testUrl = process.env.CACHE_STORE_TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;

suite("Postgres conversation boundary store", () => {
  const schema = `cache_test_${crypto.randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let admin: Pool;
  let createStore: () => ConversationBoundaryStore;
  const boundary = { messageIndex: 2, contentIndex: 1, prefixHash: "hash-only", ttl: "5m" as const };
  const expiry = () => Date.now() + 300_000;
  const input = (key: string) => ({ key, userId: "owner", expectedVersion: null, boundary, expiresAt: expiry() });

  beforeAll(async () => {
    admin = new Pool({ connectionString: testUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: testUrl, options: `-c search_path=${schema}` });
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY)');
    const migration = await Bun.file(new URL("../drizzle/0006_conversation_cache_boundaries.sql", import.meta.url)).text();
    // Generated FK qualifies public.user; tests substitute only our private schema.
    await pool.query(migration.replaceAll('"public".', `"${schema}".`));
    await pool.query('INSERT INTO "user" (id) VALUES ($1), ($2)', ["owner", "other"]);
    // The factory uses only the injected isolated test pool.
    const { createConversationBoundaryStore } = await import("./conversation-cache-store");
    createStore = () => createConversationBoundaryStore({
      async executeRaw(queryText, params = []) {
        const result = await pool.query(queryText, params);
        return { rows: result.rows, rowCount: result.rowCount ?? 0, command: result.command, fields: result.fields };
      },
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  test("round trips only receipt fields and filters expired/missing keys", async () => {
    const store = createStore();
    expect(await store.get("missing")).toBeUndefined();
    const value = input("roundtrip");
    await store.put(value);
    const receipt = await store.get(value.key);
    expect(receipt).toEqual({ version: expect.any(String), boundary, expiresAt: value.expiresAt });
    expect(receipt!.version).toMatch(/^[0-9a-f-]{36}$/);
    await store.put({ ...input("expired"), expiresAt: Date.now() - 1000 });
    expect(await store.get("expired")).toBeUndefined();
  });

  test("concurrent initial writers cannot overwrite the winner", async () => {
    const a = createStore();
    const b = createStore();
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).put({
      ...input("initial-race"), boundary: { ...boundary, messageIndex: index },
    })));
    const winner = await a.get("initial-race");
    await b.put({ ...input("initial-race"), boundary: { ...boundary, messageIndex: 99 } });
    expect(await b.get("initial-race")).toEqual(winner);
  });

  test("CAS permits one winner across replicas and rejects stale or missing versions", async () => {
    const a = createStore();
    const b = createStore();
    await a.put(input("cas"));
    const previous = (await a.get("cas"))!;
    await Promise.all([a, b].map((store, index) => store.put({
      ...input("cas"), expectedVersion: previous.version, boundary: { ...boundary, messageIndex: 10 + index },
    })));
    const winner = (await b.get("cas"))!;
    expect(winner.version).not.toBe(previous.version);
    expect([10, 11]).toContain(winner.boundary.messageIndex);
    await a.put({ ...input("cas"), expectedVersion: previous.version });
    expect(await a.get("cas")).toEqual(winner);
    await b.put({ ...input("never-insert"), expectedVersion: previous.version });
    expect(await b.get("never-insert")).toBeUndefined();
  });

  test("expired rows can be replaced without changing owner, and deletion cascades", async () => {
    const store = createStore();
    await store.get("warm-up-cleanup");
    await store.put({ ...input("replace-expired"), expiresAt: Date.now() - 1000 });
    await store.put(input("replace-expired"));
    expect((await store.get("replace-expired"))!.boundary).toEqual(boundary);
    await store.put({ ...input("foreign"), userId: "other" });
    const other = (await store.get("foreign"))!;
    await store.put({ ...input("foreign"), expectedVersion: other.version });
    expect(await store.get("foreign")).toEqual(other);
    await pool.query('DELETE FROM "user" WHERE id = $1', ["other"]);
    expect(await store.get("foreign")).toBeUndefined();
  });

  test("opportunistic cleanup is bounded and leaves live receipts untouched", async () => {
    await pool.query(`INSERT INTO conversation_cache_boundaries
      (key, user_id, version, message_index, content_index, prefix_hash, ttl, expires_at)
      SELECT 'cleanup-' || n, 'owner', 'v', 0, 0, 'h', '5m', now() - interval '1 hour'
      FROM generate_series(1, 150) n`);
    const store = createStore();
    await store.get("roundtrip");
    const count = await pool.query("SELECT count(*)::int AS n FROM conversation_cache_boundaries WHERE key LIKE 'cleanup-%'");
    expect(count.rows[0].n).toBe(50);
    await store.get("roundtrip");
    const secondCount = await pool.query("SELECT count(*)::int AS n FROM conversation_cache_boundaries WHERE key LIKE 'cleanup-%'");
    expect(secondCount.rows[0].n).toBe(50);
    expect(await store.get("roundtrip")).toBeDefined();
  });
});
