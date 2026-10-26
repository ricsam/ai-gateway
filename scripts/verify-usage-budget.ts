import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// Separate process: the unit suite mocks auth modules. Only a newly-created
// database is modified, never DATABASE_URL or the administrator database.
const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (CREATE DATABASE permission)");
const runId = crypto.randomUUID().replaceAll("-", "");
const database = `usage_budget_${runId}`;
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/usage-budget-");
const manifest = { runId, database, paths: [scratch], databaseCreated: false, databaseDropped: false };
const saveManifest = () => writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
await saveManifest();
const admin = new Pool({ connectionString: adminUrl });
let applicationPool: Pool | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const observations: Record<string, unknown> = {};

try {
  await admin.query(`CREATE DATABASE "${database}"`);
  manifest.databaseCreated = true;
  await saveManifest();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  process.env.BASE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const { pool } = await import("../backend/db");
  applicationPool = pool;
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  const { handleUsage, handleCredits } = await import("../backend/public-api");
  const { hashApiKey } = await import("../backend/api-key-utils");
  const { addCredits, deductCredits } = await import("../backend/credit-service");
  const { updateUser, createLocalUser } = await import("../backend/user-service");
  const { default: resetCredits } = await import("../backend/jobs/reset-credits");
  const { nativeMonthlyUsageQuery } = await import("../backend/usage-budget-query");
  const { currentUtcMonthRange } = await import("../backend/usage-contract");
  const range = currentUtcMonthRange();
  const previousMonth = new Date(range.start.getTime() - 1);
  const principal = { actorType: "user" as const, actorId: "fixture-admin", userId: "fixture-admin", scopes: new Set<string>() };
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/usage") return handleUsage(request);
      if (path === "/v1/credits") return handleCredits(request);
      return new Response("Not found", { status: 404 });
    },
  });
  async function keyFor(userId: string, scopes = ["credits.read"]) {
    const key = `aig_${crypto.randomUUID()}`;
    await pool.query("INSERT INTO api_keys (id,user_id,name,key_hash,key_prefix,scopes,created_at) VALUES ($1,$2,'Verify',$3,$4,$5,now())",
      [crypto.randomUUID(), userId, await hashApiKey(key), key.slice(0, 13), scopes]);
    return key;
  }
  async function fixture(id: string, opening: number, allocation: number) {
    await pool.query(`INSERT INTO "user" (id,username,name,email,credit_balance,default_monthly_credits,created_at,updated_at)
      VALUES ($1,$1,$1,$1 || '@example.test',$2,$3,$4,$4)`, [id, opening, allocation, previousMonth]);
    if (opening > 0) await event(id, previousMonth, "admin_adjustment", opening, 0);
    return keyFor(id);
  }
  async function event(userId: string, time: Date, type: string, added: number | string, consumed: number | string) {
    await pool.query("INSERT INTO credit_events (id,request_id,user_id,time,type,credits_added,credits_consumed) VALUES ($1,$1,$2,$3,$4,$5,$6)",
      [crypto.randomUUID(), userId, time, type, added, consumed]);
  }
  async function usage(key: string, label?: string, query = "") {
    const response = await fetch(`${server!.url}v1/usage${query}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as any;
    assert.equal(body.period.start, range.start.toISOString());
    assert.equal(body.period.end, range.endExclusive.toISOString());
    assert.ok(Number.isFinite(Date.parse(body.observed_at)));
    if (label) observations[label] = body;
    return body;
  }
  function available(body: any, expected: Record<string, number | null>) {
    assert.equal(body.budget.status, "available", JSON.stringify(body));
    assert.equal(body.budget.reason, null);
    assert.equal(body.budget.remaining, body.credits.balance);
    assert.equal(body.budget.metered_spend, body.credits.used);
    for (const [field, value] of Object.entries(expected)) assert.equal(body.budget[field], value, field);
  }
  const key = await fixture("owner", 150, 150);
  const otherKey = await fixture("other", 999, 0);
  available(await usage(key, "opening"), { opening_balance: 150, effective_budget: 150, top_ups: 0 });
  await addCredits({ userId: "owner", amount: 100, type: "admin_adjustment", description: "Top up" });
  await deductCredits({ userId: "owner", amount: 163.22, type: "api", description: "Metered", inputTokens: 11, outputTokens: 7 });
  const topped = await usage(key, "top_up_and_spend");
  available(topped, { opening_balance: 150, top_ups: 100, effective_budget: 250, remaining: 86.78, metered_spend: 163.22 });
  assert.ok(Math.abs(topped.budget.percent_used - 65.288) < 1e-10);
  assert.equal(topped.credits.monthly_allocation, 150);
  assert.ok(Math.abs(topped.credits.percent_used - 163.22 / 150 * 100) < 1e-10);
  assert.equal(topped.requests, 1);
  assert.equal(topped.tokens.total, 18);
  // Supplying a different owner or time range cannot escape the key owner/current month.
  available(await usage(key, undefined, "?user_id=other&start_date=2001-01-01"), { effective_budget: 250, remaining: 86.78 });
  available(await usage(otherKey), { opening_balance: 999, effective_budget: 999, metered_spend: 0 });
  await addCredits({ userId: "owner", amount: -20, type: "admin_adjustment", description: "Remove funds" });
  available(await usage(key, "negative_adjustment"), { adjustment_removals: 20, effective_budget: 230, remaining: 66.78, net_funding: 80 });
  await updateUser("owner", { defaultMonthlyCredits: 200 }, principal, crypto.randomUUID());
  const edited = await usage(key, "allocation_edit");
  available(edited, { effective_budget: 230, remaining: 66.78 });
  assert.equal(edited.credits.monthly_allocation, 200);
  assert.equal(edited.credits.percent_used, 163.22 / 200 * 100);
  await resetCredits();
  available(await usage(key, "reset_adds"), { reset_additions: 133.22, remaining: 200, effective_budget: 363.22 });
  await addCredits({ userId: "owner", amount: 100, type: "admin_adjustment", description: "Post reset top up" });
  await resetCredits();
  available(await usage(key, "reset_removes"), { top_ups: 200, reset_removals: 100, remaining: 200, metered_spend: 163.22, effective_budget: 363.22 });
  await resetCredits(); // Zero-delta resets are valid, not duplicate grants.
  available(await usage(key), { effective_budget: 363.22, reset_removals: 100 });
  const settlement = await deductCredits({ userId: "owner", amount: 500, type: "api", description: "Exhaust balance" });
  assert.equal(settlement.creditsCharged, 200);
  available(await usage(key, "exhausted"), { remaining: 0, effective_budget: 363.22, metered_spend: 363.22, percent_used: 100 });
  const zeroKey = await fixture("zero", 0, 0);
  available(await usage(zeroKey, "zero_budget"), { effective_budget: 0, percent_used: null, remaining: 0 });
  await addCredits({ userId: "zero", amount: 25, type: "admin_adjustment", description: "No recurring allocation" });
  const zeroAllocation = await usage(zeroKey, "zero_allocation_topup");
  available(zeroAllocation, { opening_balance: 0, top_ups: 25, effective_budget: 25, percent_used: 0 });
  assert.equal(zeroAllocation.credits.percent_used, null);
  await resetCredits();
  available(await usage(zeroKey), { remaining: 25, reset_additions: 0, reset_removals: 0 });
  const created = await createLocalUser({ username: "created", name: "Created", email: "created@example.test", password: crypto.randomUUID(), creditBalance: 150, defaultMonthlyCredits: 0 }, principal, crypto.randomUUID());
  available(await usage(await keyFor(created.id), "new_account"), { opening_balance: 0, top_ups: 150, effective_budget: 150 });

  // Carry-in is net historical funding/consumption, not allocation or total grants.
  const carryKey = await fixture("carry", 100, 0);
  await event("carry", previousMonth, "api", 0, 20);
  await event("carry", previousMonth, "monthly_reset", 0, 50);
  await pool.query('UPDATE "user" SET credit_balance=30 WHERE id=\'carry\'');
  for (const type of ["chat", "api", "embedding"]) await event("carry", range.start, type, 0, 1);
  await pool.query('UPDATE "user" SET credit_balance=27 WHERE id=\'carry\'');
  available(await usage(carryKey, "historical_carry_in"), { opening_balance: 30, reset_removals: 0, top_ups: 0, effective_budget: 30, metered_spend: 3, remaining: 27 });
  const timezoneClient = await pool.connect();
  try {
    await timezoneClient.query("SET TIME ZONE 'Pacific/Honolulu'");
    const query = new PgDialect().sqlToQuery(nativeMonthlyUsageQuery("carry"));
    const result = (await timezoneClient.query(query.sql, query.params)).rows[0];
    assert.equal(result.period_start.toISOString(), range.start.toISOString());
    assert.equal(result.period_end.toISOString(), range.endExclusive.toISOString());
    assert.equal(Number(result.opening_balance), 30);
  } finally { await timezoneClient.query("RESET TIME ZONE"); timezoneClient.release(); }

  // Exact UTC boundary classification, including a replacement at period.start.
  const boundaryKey = await fixture("boundary", 250, 150);
  await event("boundary", range.start, "monthly_reset", 0, 100);
  await pool.query('UPDATE "user" SET credit_balance=150 WHERE id=\'boundary\'');
  available(await usage(boundaryKey, "reset_at_boundary"), { opening_balance: 250, reset_removals: 100, effective_budget: 150, remaining: 150 });
  const futureKey = await fixture("future", 0, 0);
  await event("future", range.endExclusive, "admin_adjustment", 1, 0);
  await pool.query('UPDATE "user" SET credit_balance=1 WHERE id=\'future\'');
  assert.equal((await usage(futureKey, "future_event")).budget.reason, "future_ledger_event");
  // Clock skew within this month is also explicitly unavailable, not omitted.
  const skewKey = await fixture("skew", 0, 0);
  await event("skew", new Date(Date.now() + 60_000), "admin_adjustment", 1, 0);
  await pool.query('UPDATE "user" SET credit_balance=1 WHERE id=\'skew\'');
  assert.equal((await usage(skewKey)).budget.reason, "future_ledger_event");
  const negativeOpeningKey = await fixture("negative-opening", 0, 0);
  await event("negative-opening", previousMonth, "api", 0, 1);
  await event("negative-opening", range.start, "admin_adjustment", 1, 0);
  assert.equal((await usage(negativeOpeningKey)).budget.reason, "ledger_balance_mismatch");
  const missingKey = await fixture("missing", 0, 0);
  await pool.query('UPDATE "user" SET credit_balance=1 WHERE id=\'missing\'');
  const missing = await usage(missingKey, "unreconciled");
  assert.equal(missing.budget.status, "unavailable");
  assert.equal(missing.budget.reason, "ledger_balance_mismatch");
  assert.equal(missing.budget.effective_budget, null);
  assert.equal(missing.budget.remaining, 1);
  for (const [id, type, added, consumed] of [
    ["unsupported", "unknown", 0, 0], ["invalid", "usage", 1, 1],
    ["negative", "admin_adjustment", -1, 0], ["nan", "admin_adjustment", "NaN", 0],
  ] as const) {
    const invalidKey = await fixture(id, 0, 0);
    await event(id, previousMonth, type, added, consumed);
    assert.equal((await usage(invalidKey)).budget.reason, "unsupported_ledger_event", id);
  }
  // Existing sub-1e-8 writer rounding is not silently accepted as funding.
  const roundingKey = await fixture("rounding", 1, 0);
  await deductCredits({ userId: "rounding", amount: 0.000000005, type: "api", description: "Rounding boundary" });
  assert.equal((await usage(roundingKey, "rounding_drift")).budget.reason, "ledger_balance_mismatch");

  // Real HTTP checks for missing/invalid/insufficient scopes. No management key required.
  const forbidden = await keyFor("owner", ["models.read"]);
  for (const [token, status] of [[undefined, 401], ["aigm_not-an-inference-key", 401], [forbidden, 403]] as const) {
    const response: Response = await fetch(`${server.url}v1/usage`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, status);
  }
  const credits = await fetch(`${server.url}v1/credits`, { headers: { authorization: `Bearer ${zeroKey}` } }).then((r) => r.json());
  assert.deepEqual(credits, { object: "credit_balance", dashboard_url: "http://localhost:3000/profile", currency: "USD", balance: 25, monthly_allocation: 0 });

  // Deterministically pin the production SQL's statement snapshot behind a test
  // advisory gate, then commit both a top-up and a settlement before releasing it.
  // The wrapper changes no report expressions. Every amount must remain OLD.
  const concurrentKey = await fixture("concurrent", 150, 150);
  const gate = await pool.connect();
  const gateId = 294;
  await gate.query("SELECT pg_advisory_lock($1)", [gateId]);
  try {
    const query = new PgDialect().sqlToQuery(sql`
      WITH gate AS MATERIALIZED (SELECT pg_advisory_xact_lock(${gateId}))
      SELECT report.* FROM gate CROSS JOIN (${nativeMonthlyUsageQuery("concurrent")}) report
    `);
    const pending = pool.query(query.sql, query.params);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const locks = await pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [gateId]);
      if (locks.rowCount) { waiting = true; break; }
      await Bun.sleep(10);
    }
    assert.ok(waiting, "snapshot query must reach the gate");
    await addCredits({ userId: "concurrent", amount: 100, type: "admin_adjustment", description: "Concurrent top up" });
    await deductCredits({ userId: "concurrent", amount: 163.22, type: "api", description: "Concurrent settlement" });
    await gate.query("SELECT pg_advisory_unlock($1)", [gateId]);
    const old = (await pending).rows[0];
    assert.equal(Number(old.balance), 150);
    assert.equal(Number(old.spend), 0);
    assert.equal(Number(old.top_ups), 0);
    assert.equal(Number(old.effective_budget), 150);
    assert.equal(old.unavailable_reason, null);
    available(await usage(concurrentKey, "after_concurrent_commits"), { effective_budget: 250, remaining: 86.78, metered_spend: 163.22 });
  } finally { await gate.query("SELECT pg_advisory_unlock_all()"); gate.release(); }

  // Exercise the actual reset writer while an uncommitted balance adjustment
  // holds its user row. Reset must use the committed new balance, not a stale delta.
  const writer = await pool.connect();
  await writer.query("BEGIN");
  let resetting: Promise<unknown> | undefined;
  try {
    await writer.query('UPDATE "user" SET credit_balance=credit_balance+100 WHERE id=\'concurrent\'');
    resetting = resetCredits();
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const locks = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%default_monthly_credits%'");
      if (locks.rowCount) { blocked = true; break; }
      await Bun.sleep(10);
    }
    assert.ok(blocked, "reset must wait for the account row");
    await writer.query("INSERT INTO credit_events (id,request_id,user_id,time,type,credits_added) VALUES ($1,$1,'concurrent',clock_timestamp(),'admin_adjustment',100)", [crypto.randomUUID()]);
    await writer.query("COMMIT");
    await resetting;
    available(await usage(concurrentKey, "concurrent_reset"), { remaining: 150, reset_removals: 36.78, effective_budget: 313.22 });
  } finally { await writer.query("ROLLBACK"); writer.release(); await resetting; }

  // Repeated real endpoint reads while production writers run. Every response
  // must reconcile, not merely responses before/after the entire workload.
  const stressKey = await fixture("stress", 100, 0);
  const writes = (async () => {
    for (let i = 0; i < 20; i++) {
      await addCredits({ userId: "stress", amount: 2, type: "admin_adjustment", description: "Stress top up" });
      await deductCredits({ userId: "stress", amount: 1, type: "api", description: "Stress settlement" });
    }
  })();
  for (let i = 0; i < 30; i++) {
    const body = await usage(stressKey);
    available(body, {});
    assert.equal(body.budget.effective_budget - body.budget.metered_spend, body.budget.remaining);
  }
  await writes;
  available(await usage(stressKey), { top_ups: 40, metered_spend: 20, remaining: 120 });
  await writeFile(join(scratch, "responses.json"), JSON.stringify(observations, null, 2));
  console.log(`Usage budget endpoint, ledger, permissions and concurrency verification passed; responses: ${scratch}/responses.json`);
} finally {
  server?.stop(true);
  await applicationPool?.end();
  if (manifest.databaseCreated) {
    await admin.query(`DROP DATABASE "${database}"`);
    manifest.databaseDropped = true;
  }
  await admin.end();
  await saveManifest();
}
