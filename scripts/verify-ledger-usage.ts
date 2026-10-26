import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Run independently of bun test, whose handler tests mock authentication.
// Never use DATABASE_URL for fixtures: only the fresh database created below.
const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (permission to create temporary databases)");
const runId = crypto.randomUUID().replaceAll("-", "");
const database = `ledger_usage_${runId}`;
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/ledger-usage-");
const manifest = { runId, databases: [database], paths: [scratch], created: false, cleanedUp: false };
const saveManifest = () => writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
await saveManifest();
const admin = new Pool({ connectionString: adminUrl });
let applicationPool: Pool | undefined;

type Totals = { creditsConsumed: number; requests: number };
type Summary = Totals & {
  inputTokens: number; outputTokens: number;
  byModel: Array<Totals & { model: string | null }>;
  byUser: Array<Totals & { userId: string; username: string }>;
};
type LedgerEvent = {
  id: string; userId: string; type: string; creditsAdded: number; creditsConsumed: number;
};
type Fixture = {
  type: string; userId: string; source: string; model: string | null;
  cost: number; added?: number; ageDays?: number; metered: boolean;
};

try {
  await admin.query(`CREATE DATABASE "${database}"`);
  manifest.created = true;
  await saveManifest();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  process.env.BASE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.SETTINGS_ENCRYPTION_KEY = `v1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
  // App imports must follow test environment setup.
  const { pool } = await import("../backend/db");
  applicationPool = pool;
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  await pool.query(`INSERT INTO "user" (id, username, name, email, role, credit_balance, created_at, updated_at) VALUES
    ('admin', 'admin', 'Admin', 'admin@example.test', 'admin', 0, now(), now()),
    ('alice', 'alice', 'Alice', 'alice@example.test', 'user', 150, now(), now()),
    ('bob', 'bob', 'Bob', 'bob@example.test', 'user', 0, now(), now())`);
  const { hashApiKey } = await import("../backend/api-key-utils");
  const managementKey = `aigm_${runId}`;
  await pool.query("INSERT INTO management_api_keys (id, name, key_hash, key_prefix, scopes, created_by_user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
    ["management", "Ledger verification", await hashApiKey(managementKey), managementKey.slice(0, 13), ["users.read", "users.write", "usage.read"], "admin"]);
  const { handleManagementApi } = await import("../backend/management-api");
  async function management<T>(path: string, method = "GET", data?: unknown): Promise<T> {
    const response = await handleManagementApi(new Request(`http://localhost:3000/management/v1${path}`, {
      method, headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
    assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);
    return response.json() as Promise<T>;
  }
  const summary = async (query = "") => (await management<{ data: Summary }>(`/usage/summary${query}`)).data;
  const ledger = () => management<{ data: LedgerEvent[]; pagination: { total: number } }>("/usage/events?limit=100");
  const zero: Summary = { creditsConsumed: 0, requests: 0, inputTokens: 0, outputTokens: 0, byModel: [], byUser: [] };
  function assertSummary(actual: Summary, expected: Summary, context: string) {
    // Ordering of tied aggregate rows is intentionally unspecified by the API.
    assert.deepEqual({
      creditsConsumed: actual.creditsConsumed, requests: actual.requests,
      inputTokens: actual.inputTokens, outputTokens: actual.outputTokens,
      byModel: [...actual.byModel].sort((a, b) => String(a.model).localeCompare(String(b.model))),
      byUser: [...actual.byUser].sort((a, b) => a.userId.localeCompare(b.userId)),
    }, {
      ...expected,
      byModel: [...expected.byModel].sort((a, b) => String(a.model).localeCompare(String(b.model))),
      byUser: [...expected.byUser].sort((a, b) => a.userId.localeCompare(b.userId)),
    }, context);
  }

  const reset = await management<{ data: { creditBalance: number } }>("/users/alice", "PATCH", { creditBalance: 0 });
  assert.equal(reset.data.creditBalance, 0);
  assert.equal((await pool.query('SELECT credit_balance::float8 AS balance FROM "user" WHERE id = $1', ["alice"])).rows[0].balance, 0);
  const resetLedger = await ledger();
  assert.equal(resetLedger.pagination.total, 1);
  const resetEvent = resetLedger.data[0]!;
  assert.equal(resetEvent.type, "admin_adjustment");
  assert.equal(resetEvent.userId, "alice");
  assert.equal(resetEvent.creditsConsumed, 150);
  assert.equal(resetEvent.creditsAdded, 0);
  // This is the pre-fix reproduction: the reset must remain auditable, not usage.
  assertSummary(await summary(), zero, "$150 -> $0 admin reset must not count as consumption or requests");
  await management("/users/alice", "PATCH", { creditBalance: 25 });
  assertSummary(await summary(), zero, "admin credit additions must not count as requests either");

  await pool.query("INSERT INTO groups (id, name, created_at, updated_at) VALUES ('alice-group','Alice group',now(),now()), ('empty-group','Empty group',now(),now()); INSERT INTO group_members (group_id,user_id,joined_at) VALUES ('alice-group','alice',now())");
  // Explicit expected membership, independent of the production type predicate.
  // A model/source cannot turn an adjustment into usage, or hide metered usage.
  const fixtures: Fixture[] = [
    { type: "usage", userId: "alice", source: "admin", model: "model-a", cost: 1, metered: true },
    { type: "chat", userId: "alice", source: "chat", model: "model-a", cost: 2, metered: true },
    { type: "api", userId: "alice", source: "api", model: null, cost: 4, metered: true },
    { type: "embedding", userId: "bob", source: "api", model: "model-b", cost: 8, metered: true },
    { type: "usage", userId: "alice", source: "api", model: "model-free", cost: 0, metered: true },
    { type: "usage", userId: "bob", source: "admin", model: null, cost: 0, metered: true },
    { type: "usage", userId: "bob", source: "api", model: "model-old", cost: 16, ageDays: 40, metered: true },
    { type: "admin_adjustment", userId: "alice", source: "api", model: "model-a", cost: 100, metered: false },
    { type: "admin_adjustment", userId: "bob", source: "chat", model: "model-b", cost: 0, added: 100, metered: false },
    { type: "monthly_reset", userId: "alice", source: "api", model: "model-a", cost: 200, metered: false },
    { type: "monthly_reset", userId: "bob", source: "api", model: "model-b", cost: 0, added: 200, metered: false },
  ];
  for (const fixture of fixtures) {
    await pool.query(`INSERT INTO credit_events (id, time, request_id, user_id, type, source, model, credits_consumed, credits_added, input_tokens, output_tokens)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,10,3)`, [crypto.randomUUID(), new Date(Date.now() - (fixture.ageDays ?? 0) * 86_400_000), crypto.randomUUID(), fixture.userId, fixture.type, fixture.source, fixture.model, fixture.cost, fixture.added ?? 0]);
  }
  function expected(rows: Fixture[]): Summary {
    const result: Summary = { ...zero, byModel: [], byUser: [] };
    for (const row of rows) {
      result.creditsConsumed += row.cost; result.requests++; result.inputTokens += 10; result.outputTokens += 3;
      let model = result.byModel.find((entry) => entry.model === row.model);
      if (!model) { model = { model: row.model, creditsConsumed: 0, requests: 0 }; result.byModel.push(model); }
      model.creditsConsumed += row.cost; model.requests++;
      let user = result.byUser.find((entry) => entry.userId === row.userId);
      if (!user) { user = { userId: row.userId, username: row.userId, creditsConsumed: 0, requests: 0 }; result.byUser.push(user); }
      user.creditsConsumed += row.cost; user.requests++;
    }
    return result;
  }
  const recent = fixtures.filter((row) => row.metered && !row.ageDays);
  assertSummary(await summary(), expected(recent), "mixed ledger excludes adjustments from all aggregates");
  assertSummary(await summary("?userId=alice"), expected(recent.filter((row) => row.userId === "alice")), "user filter");
  assertSummary(await summary("?groupId=alice-group"), expected(recent.filter((row) => row.userId === "alice")), "group filter");
  for (const query of ["?groupId=empty-group", "?userId=missing", "?groupId=missing", "?userId=bob&groupId=alice-group"]) {
    assertSummary(await summary(query), zero, `empty/intersected scope: ${query}`);
  }
  assertSummary(await summary("?userId=&groupId="), expected(recent), "empty filter strings leave scope unfiltered");
  assertSummary(await summary("?days=1"), expected(recent), "short lookback excludes historical usage");
  assertSummary(await summary("?days=60"), expected(fixtures.filter((row) => row.metered)), "extended lookback includes historical usage");
  const all = await ledger();
  assert.equal(all.pagination.total, fixtures.length + 2, "full ledger keeps both real admin changes and every fixture");
  assert.equal(all.data.length, all.pagination.total);
  assert.deepEqual(all.data.find((event) => event.id === resetEvent.id), resetEvent, "reset ledger row remains unchanged");
  assert.equal(all.data.filter((event) => event.type === "monthly_reset").length, 2);
  assert.equal((await management<{ data: { creditBalance: number } }>("/users/alice")).data.creditBalance, 25, "summary reads must not alter balances");
  console.log("Ledger usage verification passed: real admin reset, full ledger preservation, metered types, free requests, source/model independence, filters and lookback.");
} finally {
  try {
    await applicationPool?.end();
    // Only drop the exact database successfully created by this run. Never FORCE.
    if (manifest.created) await admin.query(`DROP DATABASE "${database}"`);
    manifest.cleanedUp = true;
    await saveManifest();
  } finally {
    await admin.end();
    console.log(`Resource manifest: ${scratch}/manifest.json`);
  }
}
