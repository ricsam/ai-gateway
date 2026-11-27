#!/usr/bin/env bun
// End-to-end verification of monthly credit control against fresh TimescaleDB databases:
// migration 0008 on existing accounts, the monthly run in reset and rollover mode (rollover cap
// trimming and skipping, once per UTC month, exact ledger amounts, waiting for a concurrent
// writer), the monthly spend limit (admission on both inference APIs over HTTP, clamped and
// concurrent settlement), the management API, group bulk updates, /v1/credits and /v1/usage.
// Run separately from bun test, whose handler tests mock modules. Only the database this
// script creates is modified; never point it at DATABASE_URL.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (permission to create temporary databases)");
const runId = crypto.randomUUID().replaceAll("-", "");
const database = `credit_control_${runId}`;
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/credit-control-");
const priorFolder = join(scratch, "prior-migrations");
const manifest = { runId, databases: [database], paths: [scratch, priorFolder], databaseCreated: false, cleanedUp: false };
const saveManifest = () => writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
await saveManifest();
const admin = new Pool({ connectionString: adminUrl });
let applicationPool: Pool | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

try {
  await admin.query(`CREATE DATABASE "${database}"`);
  manifest.databaseCreated = true;
  await saveManifest();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  process.env.DATABASE_URL = url.toString();
  process.env.BASE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = crypto.randomUUID() + crypto.randomUUID();
  process.env.SETTINGS_ENCRYPTION_KEY = `v1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;
  // App imports must follow the environment setup.
  const { pool } = await import("../backend/db");
  applicationPool = pool;
  const { currentUtcMonthRange } = await import("../backend/usage-contract");
  const range = currentUtcMonthRange();
  const previousMonth = new Date(range.start.getTime() - 60_000);
  /** A moment in a later UTC month, for monthly runs that have not happened yet. */
  const laterMonth = (offset: number) => new Date(Date.UTC(range.start.getUTCFullYear(), range.start.getUTCMonth() + offset, 1, 0, 1));

  // 1. Accounts from before migration 0008 keep the monthly reset, with no cap or limit.
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const cutoff = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0008_credit_rollover");
  assert.ok(cutoff > 0, "migration 0008 is in the journal");
  const priorEntries = journal.entries.slice(0, cutoff) as Array<{ tag: string }>;
  await mkdir(join(priorFolder, "meta"), { recursive: true });
  await writeFile(join(priorFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: priorEntries }));
  for (const entry of priorEntries) await copyFile(`drizzle/${entry.tag}.sql`, join(priorFolder, `${entry.tag}.sql`));
  await migrate(drizzle(pool), { migrationsFolder: priorFolder });
  await pool.query(`INSERT INTO "user" (id, username, name, email, role, credit_balance, default_monthly_credits, created_at, updated_at) VALUES
    ('admin', 'admin', 'Admin', 'admin@example.test', 'admin', 0, 0, now(), now()),
    ('legacy', 'legacy', 'Legacy', 'legacy@example.test', 'user', 13.22, 100, now(), now())`);
  await pool.query("INSERT INTO credit_events (id, request_id, user_id, time, source, type, credits_added) VALUES ($1, $1, 'legacy', $2, 'admin', 'admin_adjustment', 13.22)", [crypto.randomUUID(), previousMonth]);
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  assert.deepEqual((await pool.query(`SELECT monthly_credit_mode, rollover_cap, monthly_spend_limit, monthly_credits_applied_at, credit_balance::text AS balance
    FROM "user" WHERE id = 'legacy'`)).rows[0], { monthly_credit_mode: "reset", rollover_cap: null, monthly_spend_limit: null, monthly_credits_applied_at: null, balance: "13.22000000" });
  for (const [assignment, constraint] of [
    ["monthly_credit_mode = 'bank'", "user_monthly_credit_mode_check"],
    ["rollover_cap = -1", "user_rollover_cap_check"],
    ["monthly_spend_limit = -0.01", "user_monthly_spend_limit_check"],
  ] as const) {
    await assert.rejects(pool.query(`UPDATE "user" SET ${assignment} WHERE id = 'legacy'`), (error: Error) => error.message.includes(constraint));
  }

  // 2. The management API takes, validates and returns credit control.
  const { hashApiKey } = await import("../backend/api-key-utils");
  const { handleManagementApi } = await import("../backend/management-api");
  const managementKey = `aigm_${runId}`;
  await pool.query("INSERT INTO management_api_keys (id, name, key_hash, key_prefix, scopes, created_by_user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
    ["management", "Credit control verification", await hashApiKey(managementKey), managementKey.slice(0, 13), ["users.read", "users.write", "groups.read"], "admin"]);
  async function management(path: string, method = "GET", data?: unknown, status = 200): Promise<any> {
    const response = await handleManagementApi(new Request(`http://localhost:3000/management/v1${path}`, {
      method, headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    }));
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return response.json();
  }
  const createUser = async (username: string, fields: Record<string, unknown>) => (await management("/users", "POST", {
    username, email: `${username}@example.test`, name: username, password: "Verify-password-123", ...fields,
  }, 201)).data;
  const control = (user: Record<string, unknown>) => ({
    monthlyCreditMode: user.monthlyCreditMode, rolloverCap: user.rolloverCap, monthlySpendLimit: user.monthlySpendLimit,
    monthlySpendRemaining: user.monthlySpendRemaining, monthlyCreditsAppliedAt: user.monthlyCreditsAppliedAt,
  });
  const banked = await createUser("banked", { creditBalance: 550, defaultMonthlyCredits: 100, monthlyCreditMode: "rollover", rolloverCap: 600, monthlySpendLimit: 300 });
  assert.deepEqual(control(banked), { monthlyCreditMode: "rollover", rolloverCap: 600, monthlySpendLimit: 300, monthlySpendRemaining: 300, monthlyCreditsAppliedAt: null });
  const growing = await createUser("growing", { creditBalance: 86.78, defaultMonthlyCredits: 100, monthlyCreditMode: "rollover" });
  const topped = await createUser("topped", { creditBalance: 650, defaultMonthlyCredits: 100, monthlyCreditMode: "rollover", rolloverCap: 600 });
  const resetter = await createUser("resetter", { creditBalance: 13.22, defaultMonthlyCredits: 100 });
  assert.deepEqual(control(resetter), { monthlyCreditMode: "reset", rolloverCap: null, monthlySpendLimit: null, monthlySpendRemaining: null, monthlyCreditsAppliedAt: null });
  const idle = await createUser("idle", { creditBalance: 5, defaultMonthlyCredits: 0, monthlyCreditMode: "rollover", rolloverCap: 0 });
  for (const [fields, message] of [
    [{ monthlyCreditMode: "bank" }, "monthlyCreditMode must be reset or rollover"],
    [{ rolloverCap: -1 }, "rolloverCap must be null or a non-negative amount"],
    [{ monthlySpendLimit: "300" }, "monthlySpendLimit must be null or a non-negative amount"],
    [{ rolloverCap: 1e13 }, "rolloverCap must be null or a non-negative amount"],
    [{ creditBalance: 1e13 }, "Credits cannot exceed"],
  ] as const) {
    const refused = await management(`/users/${banked.id}`, "PATCH", fields, 400);
    assert.equal(refused.error.code, "validation_error");
    assert.ok(refused.error.message.includes(message), refused.error.message);
    assert.equal((await management("/users", "POST", { username: "invalid", email: "invalid@example.test", name: "Invalid", password: "Verify-password-123", ...fields }, 400)).error.code, "validation_error");
  }
  assert.equal((await management("/users?search=invalid")).pagination.total, 0, "a refused create creates nothing");
  assert.deepEqual(control((await management(`/users/${banked.id}`, "PATCH", { monthlySpendLimit: null })).data), { ...control(banked), monthlySpendLimit: null, monthlySpendRemaining: null });
  assert.equal((await management(`/users/${banked.id}`, "PATCH", { monthlySpendLimit: 300 })).data.monthlySpendRemaining, 300);
  assert.deepEqual(control((await management("/users?search=banked")).data[0]), control(banked));

  // 3. The monthly run: resets replace, rollovers add up to the cap, once per UTC month.
  const { default: runMonthlyCredits } = await import("../backend/jobs/reset-credits");
  const balance = async (id: string) => (await pool.query(`SELECT credit_balance::text AS value FROM "user" WHERE id = $1`, [id])).rows[0].value as string;
  const monthlyEvents = async (id: string) => (await pool.query(`SELECT credits_added::text AS added, credits_consumed::text AS consumed, description
    FROM credit_events WHERE user_id = $1 AND type = 'monthly_reset' ORDER BY time, id`, [id])).rows as Array<{ added: string; consumed: string; description: string }>;
  assert.deepEqual(await runMonthlyCredits(), { usersReset: 2, usersRolledOver: 3, usersSkipped: 0 }, "legacy and resetter reset; banked, growing and topped roll over; idle has no monthly credits");
  assert.deepEqual(await Promise.all(["legacy", resetter.id, banked.id, growing.id, topped.id, idle.id].map((id) => balance(id))),
    ["100.00000000", "100.00000000", "600.00000000", "186.78000000", "650.00000000", "5.00000000"]);
  assert.deepEqual(await monthlyEvents(resetter.id), [{ added: "86.78000000", consumed: "0.00000000", description: "Monthly credit reset to 100.00" }]);
  assert.deepEqual(await monthlyEvents(banked.id), [{ added: "50.00000000", consumed: "0.00000000", description: "Monthly rollover of 100.00, trimmed to 50.00 by the 600.00 rollover cap" }]);
  assert.deepEqual(await monthlyEvents(growing.id), [{ added: "100.00000000", consumed: "0.00000000", description: "Monthly rollover of 100.00" }]);
  assert.deepEqual(await monthlyEvents(topped.id), [{ added: "0.00000000", consumed: "0.00000000", description: "Monthly rollover of 100.00 skipped: balance at or above the 600.00 rollover cap" }]);
  assert.deepEqual(await monthlyEvents(idle.id), []);
  assert.ok((await management(`/users/${banked.id}`)).data.monthlyCreditsAppliedAt, "the run records when it applied monthly credits");

  const { checkCreditAdmission, deductCredits } = await import("../backend/credit-service");
  await deductCredits({ userId: resetter.id, amount: 40, type: "api", description: "Verify usage" });
  await deductCredits({ userId: growing.id, amount: 6.78, type: "api", description: "Verify usage" });
  assert.deepEqual(await runMonthlyCredits(), { usersReset: 2, usersRolledOver: 0, usersSkipped: 3 }, "a second run in the month resets again but grants no second rollover");
  assert.deepEqual(await Promise.all([resetter.id, growing.id, banked.id].map((id) => balance(id))), ["100.00000000", "180.00000000", "600.00000000"]);
  assert.equal((await monthlyEvents(growing.id)).length, 1);

  assert.deepEqual(await runMonthlyCredits(laterMonth(1)), { usersReset: 2, usersRolledOver: 3, usersSkipped: 0 }, "the next month rolls over again");
  assert.deepEqual(await Promise.all([growing.id, banked.id, topped.id].map((id) => balance(id))), ["280.00000000", "600.00000000", "650.00000000"]);
  assert.deepEqual(await runMonthlyCredits(laterMonth(1)), { usersReset: 2, usersRolledOver: 0, usersSkipped: 3 });

  // Six months of $100.12345678 bank exactly $600 under a $600 cap, with exact ledger amounts.
  const exact = await createUser("exact", { defaultMonthlyCredits: 100.12345678, monthlyCreditMode: "rollover", rolloverCap: 600 });
  const exactBalances: string[] = [];
  for (let month = 2; month <= 9; month++) {
    await runMonthlyCredits(laterMonth(month));
    exactBalances.push(await balance(exact.id));
  }
  assert.deepEqual(exactBalances, ["100.12345678", "200.24691356", "300.37037034", "400.49382712", "500.61728390", "600.00000000", "600.00000000", "600.00000000"]);
  assert.equal((await monthlyEvents(exact.id))[5]!.added, "99.38271610", "the sixth month is trimmed exactly to the cap");

  // A rollover waits for a concurrent balance change and adds to the committed balance.
  const racing = await createUser("racing", { creditBalance: 450, defaultMonthlyCredits: 100, monthlyCreditMode: "rollover", rolloverCap: 600 });
  const writer = await pool.connect();
  let running: Promise<unknown> | undefined;
  try {
    await writer.query("BEGIN");
    await writer.query(`UPDATE "user" SET credit_balance = credit_balance + 100 WHERE id = $1`, [racing.id]);
    await writer.query("INSERT INTO credit_events (id, request_id, user_id, time, source, type, credits_added) VALUES ($1, $1, $2, clock_timestamp(), 'admin', 'admin_adjustment', 100)", [crypto.randomUUID(), racing.id]);
    running = runMonthlyCredits();
    let blocked = false;
    for (let attempt = 0; attempt < 200 && !blocked; attempt++) {
      blocked = Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%default_monthly_credits%'")).rowCount);
      if (!blocked) await Bun.sleep(10);
    }
    assert.ok(blocked, "the monthly run waits for the account row");
    await writer.query("COMMIT");
    await running;
    assert.equal(await balance(racing.id), "600.00000000", "550 committed + 50 trimmed by the cap, not 450 + 100");
  } finally {
    await writer.query("ROLLBACK").catch(() => undefined);
    writer.release();
    await running?.catch(() => undefined);
  }

  // 4. Group bulk updates set credit control for every distinct member.
  await pool.query("INSERT INTO groups (id, name, created_at, updated_at) VALUES ('group-a', 'Group A', now(), now()), ('group-b', 'Group B', now(), now())");
  await pool.query("INSERT INTO group_members (group_id, user_id, joined_at) VALUES ('group-a', 'legacy', now()), ('group-a', $1, now()), ('group-b', 'legacy', now()), ('group-b', $2, now())", [resetter.id, idle.id]);
  const bulk = (updates: object, status = 200) => management("/groups/bulk-user-update", "POST", { groupIds: ["group-a", "group-b"], ...updates }, status);
  assert.equal((await bulk({ monthlyCreditMode: "rollover", rolloverCap: 250, monthlySpendLimit: 75 })).data.usersUpdated, 3);
  assert.equal((await bulk({ monthlySpendLimit: null })).data.usersUpdated, 3);
  assert.equal((await bulk({ monthlyCreditMode: "monthly" }, 400)).error.code, "validation_error");
  assert.equal((await bulk({ rolloverCap: -5 }, 400)).error.code, "validation_error");
  const members = (await management("/groups/group-a")).data.members as Array<Record<string, unknown>>;
  assert.deepEqual(members.map((member) => [member.username, member.monthlyCreditMode, member.rolloverCap, member.monthlySpendLimit]).sort(),
    [["legacy", "rollover", 250, null], ["resetter", "rollover", 250, null]]);

  // 5. The monthly spend limit: admission, clamped settlement, both inference APIs and reporting.
  const limited = await createUser("limited", { creditBalance: 1000, monthlySpendLimit: 300 });
  // Last month's usage and administrator removals are not this month's spend.
  for (const [type, added, consumed] of [["admin_adjustment", 500, 0], ["api", 0, 500]] as const) {
    await pool.query("INSERT INTO credit_events (id, request_id, user_id, time, type, credits_added, credits_consumed) VALUES ($1, $1, $2, $3, $4, $5, $6)", [crypto.randomUUID(), limited.id, previousMonth, type, added, consumed]);
  }
  await management(`/users/${limited.id}`, "PATCH", { creditBalance: 980 });
  assert.deepEqual(await checkCreditAdmission(limited.id), { ok: true });
  const first = await deductCredits({ userId: limited.id, amount: 299.99, type: "api", description: "Verify usage" });
  assert.deepEqual([first.creditsCharged, first.partiallyCharged], [299.99, false]);
  assert.equal(await balance(limited.id), "680.01000000");
  assert.deepEqual(await checkCreditAdmission(limited.id), { ok: true }, "$0.01 of the limit is left");
  const crossingId = `verify-crossing-${runId}`;
  const crossing = await deductCredits({ userId: limited.id, amount: 5, type: "api", description: "Verify usage", requestId: crossingId });
  assert.deepEqual([crossing.actualCost, crossing.creditsCharged, crossing.partiallyCharged], [5, 0.01, true], "a charge never passes the monthly spend limit");
  assert.equal(await balance(limited.id), "680.00000000", "the rest of the balance is kept");
  const retried = await deductCredits({ userId: limited.id, amount: 5, type: "api", description: "Verify usage", requestId: crossingId });
  assert.deepEqual([retried.creditsCharged, retried.balanceAfter, retried.partiallyCharged], [0.01, 680, true], "a retried request ID is not charged again");
  const resetsOn = range.endExclusive.toISOString().slice(0, 10);
  const refusal = { ok: false, code: "monthly_spend_limit_reached", message: `Monthly spend limit of $300.00 reached; it resets on ${resetsOn} (UTC)` };
  assert.deepEqual(await checkCreditAdmission(limited.id), refusal);
  assert.equal((await deductCredits({ userId: limited.id, amount: 1, type: "api", description: "Verify usage" })).creditsCharged, 0);

  const { handleCredits, handlePublicChatCompletions, handleUsage } = await import("../backend/public-api");
  const { handleBedrockProxy } = await import("../backend/bedrock-proxy");
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/chat/completions") return handlePublicChatCompletions(request);
      if (path === "/api/gateway/bedrock/converse") return handleBedrockProxy(request, "converse");
      if (path === "/v1/credits") return handleCredits(request);
      if (path === "/v1/usage") return handleUsage(request);
      return new Response("Not found", { status: 404 });
    },
  });
  await pool.query(`INSERT INTO models (id, model_id, name, input_price_per_m_tok, output_price_per_m_tok, enabled, created_at, updated_at)
    VALUES ('verify-model', 'verify.model', 'Verify model', 1, 1, true, now(), now())`);
  async function keyFor(userId: string) {
    const key = `aig_${crypto.randomUUID().replaceAll("-", "")}`;
    await pool.query("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes, created_at) VALUES ($1, $2, 'Verify', $3, $4, $5, now())",
      [crypto.randomUUID(), userId, await hashApiKey(key), key.slice(0, 13), ["ai.invoke", "credits.read"]]);
    return key;
  }
  const limitedKey = await keyFor(limited.id);
  const post = (path: string, key: string, body: unknown) => fetch(`${server!.url}${path.slice(1)}`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const chat = (key: string) => post("/v1/chat/completions", key, { model: "verify.model", messages: [{ role: "user", content: "Hi" }] });
  const converse = (key: string) => post("/api/gateway/bedrock/converse", key, { modelId: "verify.model", messages: [{ role: "user", content: [{ text: "Hi" }] }] });
  const get = async (path: string, key: string) => {
    const response = await fetch(`${server!.url}${path.slice(1)}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<any>;
  };
  let response = await chat(limitedKey);
  assert.equal(response.status, 402);
  assert.deepEqual((await response.json()).error, { message: refusal.message, type: "invalid_request_error", code: "monthly_spend_limit_reached" });
  response = await converse(limitedKey);
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: { message: refusal.message, code: "monthly_spend_limit_reached" } });
  const credits = await get("/v1/credits", limitedKey);
  assert.deepEqual(credits, {
    object: "credit_balance", dashboard_url: "http://localhost:3000/profile", currency: "USD", balance: 680, monthly_allocation: 0,
    monthly_credit_mode: "reset", rollover_cap: null, monthly_spend_limit: 300, monthly_spend_remaining: 0,
  });
  let usage = await get("/v1/usage", limitedKey);
  assert.deepEqual(usage.credits, {
    used: 300, balance: 680, monthly_allocation: 0, percent_used: null,
    monthly_credit_mode: "reset", rollover_cap: null, monthly_spend_limit: 300, monthly_spend_remaining: 0,
  });
  assert.equal(usage.budget.status, "available", JSON.stringify(usage.budget));
  assert.equal(usage.budget.metered_spend, 300);

  await management(`/users/${limited.id}`, "PATCH", { monthlySpendLimit: 400 });
  assert.equal((await management(`/users/${limited.id}`)).data.monthlySpendRemaining, 100);
  for (const call of [chat, converse]) {
    response = await call(limitedKey);
    assert.equal(response.status, 503, "a raised limit admits the request, which then needs AWS");
    assert.equal((await response.json()).error.code, "provider_not_configured");
  }
  usage = await get("/v1/usage", limitedKey);
  assert.equal(usage.credits.monthly_spend_remaining, 100);
  const broke = await createUser("broke", { creditBalance: 0, monthlySpendLimit: 50 });
  response = await chat(await keyFor(broke.id));
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, "insufficient_credits", "an exhausted balance is refused as before");

  // A rollover account's usage summary reconciles, with the rollover as a monthly-run addition.
  const bankedUsage = await get("/v1/usage", await keyFor(banked.id));
  assert.equal(bankedUsage.budget.status, "available", JSON.stringify(bankedUsage.budget));
  assert.deepEqual([bankedUsage.budget.top_ups, bankedUsage.budget.reset_additions, bankedUsage.budget.remaining], [550, 50, 600]);
  assert.deepEqual([bankedUsage.credits.monthly_credit_mode, bankedUsage.credits.rollover_cap, bankedUsage.credits.monthly_spend_limit, bankedUsage.credits.monthly_spend_remaining], ["rollover", 600, 300, 300]);

  // Concurrent settlements never charge more than the limit together.
  const burst = await createUser("burst", { creditBalance: 1000, monthlySpendLimit: 100 });
  const settlements = await Promise.all(Array.from({ length: 25 }, () => deductCredits({ userId: burst.id, amount: 10, type: "api", description: "Verify burst" })));
  assert.equal(settlements.reduce((sum, settlement) => sum + settlement.creditsCharged, 0), 100);
  assert.equal(settlements.filter((settlement) => settlement.partiallyCharged).length, 15);
  assert.equal(await balance(burst.id), "900.00000000");
  assert.equal((await checkCreditAdmission(burst.id)).ok, false);

  // 6. Every account's ledger still adds up to its balance exactly.
  const unreconciled = await pool.query(`SELECT u.id FROM "user" u
    WHERE u.credit_balance <> COALESCE((SELECT SUM(credits_added - credits_consumed) FROM credit_events e WHERE e.user_id = u.id), 0)`);
  assert.deepEqual(unreconciled.rows, []);
  console.log("Credit control verification passed: migration defaults and constraints, management API validation and DTOs, monthly reset and rollover runs (cap trimming and skipping, once per month, exact amounts, concurrent writer), group bulk updates, monthly spend limit admission over both inference APIs, clamped and concurrent settlement, /v1/credits, /v1/usage and exact ledger reconciliation.");
} finally {
  server?.stop(true);
  await applicationPool?.end();
  try {
    if (manifest.databaseCreated) await admin.query(`DROP DATABASE "${database}"`);
    await rm(priorFolder, { recursive: true, force: true });
    manifest.cleanedUp = true;
    await saveManifest();
  } finally { await admin.end(); }
  console.log(`Resource manifest: ${scratch}/manifest.json`);
}
