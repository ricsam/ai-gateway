import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Run separately from bun test: handler unit tests mock the authentication module.
// Only newly created databases are modified; never run fixtures in DATABASE_URL.
const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (permission to create temporary databases)");
const suffix = crypto.randomUUID().replaceAll("-", "");
const names = { fresh: `access_fresh_${suffix}`, upgrade: `access_upgrade_${suffix}` };
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/user-access-");
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
async function assertNoLegacyColumn(pool: Pool) {
  const result = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'api_enabled'");
  assert.equal(result.rowCount, 0);
}

try {
  await createDatabase(names.fresh);
  const fresh = new Pool({ connectionString: databaseUrl(names.fresh) });
  try {
    await migrate(drizzle(fresh), { migrationsFolder: "drizzle" });
    await assertNoLegacyColumn(fresh);
  } finally { await fresh.end(); }

  // Build the exact prior migration chain, without changing historical files.
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const cutoff = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0005_remove_user_api_enabled");
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
  await pool.query(`INSERT INTO "user" (id, username, name, email, role, enabled, api_enabled, credit_balance, default_monthly_credits, created_at, updated_at) VALUES
    ('admin', 'admin', 'Admin', 'admin@example.test', 'admin', true, false, 10, 20, now(), now()),
    ('enabled', 'enabled', 'Enabled', 'enabled@example.test', 'user', true, false, 12.5, 25, now(), now()),
    ('disabled', 'disabled', 'Disabled', 'disabled@example.test', 'user', false, true, 7, 14, now(), now())`);
  const { hashApiKey } = await import("../backend/api-key-utils");
  const { authenticateApiKeyPrincipal, requireProxyScope } = await import("../backend/proxy-auth");
  async function addKey(userId: string, id = userId, options: { enabled?: boolean; expiresAt?: Date; revokedAt?: Date; scopes?: string[] } = {}) {
    const raw = `aig_${suffix}_${id}`;
    await pool.query("INSERT INTO api_keys (id, user_id, name, key_hash, key_prefix, scopes, enabled, expires_at, revoked_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
      [id, userId, id, await hashApiKey(raw), raw.slice(0, 13), options.scopes ?? ["ai.invoke", "models.read", "credits.read"], options.enabled ?? true, options.expiresAt ?? null, options.revokedAt ?? null]);
    return raw;
  }
  const key = await addKey("enabled");
  const disabledKey = await addKey("disabled");
  const authenticate = (raw = key) => authenticateApiKeyPrincipal(new Request("http://localhost:3000/v1/models", { headers: { authorization: `Bearer ${raw}` } }));
  assert.equal((await authenticate()).ok, true, "legacy api_enabled=false must not block an enabled account, even before migration");
  assert.deepEqual(await authenticate(disabledKey), { ok: false, status: 403, message: "Account disabled", code: "account_disabled" });

  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  await assertNoLegacyColumn(pool);
  assert.deepEqual((await pool.query('SELECT enabled, credit_balance::float8 AS balance, default_monthly_credits::float8 AS monthly FROM "user" WHERE id = $1', ["enabled"])).rows[0], { enabled: true, balance: 12.5, monthly: 25 });
  assert.equal((await authenticate()).ok, true, "existing keys survive migration");
  assert.equal((await authenticate(disabledKey)).ok, false, "migration must not enable disabled accounts");
  for (const [id, options] of [
    ["expired", { expiresAt: new Date(0) }], ["revoked", { revokedAt: new Date() }], ["key-disabled", { enabled: false }],
  ] as const) {
    const result = await authenticate(await addKey("enabled", id, options));
    assert.ok(!result.ok && result.status === 401, `${id} remains blocked`);
  }
  for (const raw of ["aig_unknown", "aigm_wrong_key_type"]) assert.equal((await authenticate(raw)).ok, false);
  const missing = await authenticateApiKeyPrincipal(new Request("http://localhost:3000/v1/models"));
  assert.ok(!missing.ok && missing.code === "missing_api_key");
  const scoped = await authenticate(await addKey("enabled", "read-only", { scopes: ["models.read"] }));
  assert.equal(requireProxyScope(scoped, "models.read").ok, true);
  assert.equal(requireProxyScope(scoped, "ai.invoke").ok, false);

  const { handleManagementApi } = await import("../backend/management-api");
  const managementKey = `aigm_${suffix}`;
  await pool.query("INSERT INTO management_api_keys (id, name, key_hash, key_prefix, scopes, created_by_user_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())",
    ["management", "Verify", await hashApiKey(managementKey), managementKey.slice(0, 13), ["users.read", "users.write", "groups.read"], "admin"]);
  async function management(path: string, method = "GET", data?: unknown, status = 200) {
    const response = await handleManagementApi(new Request(`http://localhost:3000/management/v1${path}`, {
      method, headers: { authorization: `Bearer ${managementKey}`, "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data),
    }));
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
    return response.json() as Promise<any>;
  }
  const createdUser = (await management("/users", "POST", {
    username: "new-user", name: "New user", email: "new@example.test", password: "Test-password-1234", apiEnabled: false,
  }, 201)).data;
  assert.equal(createdUser.enabled, true);
  assert.ok(!("apiEnabled" in createdUser));
  const newKey = await addKey(createdUser.id);
  assert.equal((await authenticate(newKey)).ok, true, "legacy create payload cannot disable API access");
  await management(`/users/${createdUser.id}`, "PATCH", { apiEnabled: false });
  assert.equal((await authenticate(newKey)).ok, true, "legacy update payload cannot disable API access");
  await management(`/users/${createdUser.id}`, "PATCH", { enabled: false, apiEnabled: true });
  assert.equal((await authenticate(newKey)).ok, false, "only account enablement controls user access");
  await management(`/users/${createdUser.id}/enable`, "POST");
  assert.equal((await authenticate(newKey)).ok, true);
  await management("/users/admin/disable", "POST", undefined, 400);

  await pool.query("INSERT INTO groups (id, name, created_at, updated_at) VALUES ('group-a', 'Group A', now(), now()), ('group-b', 'Group B', now(), now()); INSERT INTO group_members (group_id, user_id, joined_at) VALUES ('group-a','enabled',now()), ('group-b','enabled',now()), ('group-b','disabled',now())");
  const bulk = (updates: unknown, status = 200) => management("/groups/bulk-user-update", "POST", { groupIds: ["group-a", "group-b"], ...updates as object }, status);
  const { auth, authenticateRequest } = await import("../backend/auth");
  const { serializeSignedCookie } = await import("better-call");
  async function sessionRequest() {
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession("enabled", false);
    const cookie = context.authCookies.sessionToken;
    const signed = await serializeSignedCookie(cookie.name, session.token, context.secret, cookie.attributes);
    return new Request("http://localhost:3000/api/router/profile", { headers: { cookie: signed.split(";")[0]! } });
  }
  const session = await sessionRequest();
  assert.equal((await authenticateRequest(session))?.userId, "enabled");
  await bulk({ apiEnabled: false }, 400);
  assert.equal((await authenticate()).ok, true);
  assert.equal((await bulk({ enabled: false })).data.usersUpdated, 2, "overlapping memberships are deduplicated");
  assert.equal((await authenticate()).ok, false);
  assert.equal(await authenticateRequest(session), null, "disabling the account revokes login sessions too");
  assert.equal((await bulk({ enabled: true, apiEnabled: false })).data.usersUpdated, 2);
  assert.equal((await authenticate()).ok, true);
  assert.equal((await authenticate(disabledKey)).ok, true);
  assert.equal((await authenticateRequest(await sessionRequest()))?.userId, "enabled");
  const members = (await management("/groups/group-a")).data.members;
  assert.ok(members.every((member: object) => !("apiEnabled" in member)));
  const users = (await management("/users")).data;
  assert.ok(users.every((user: object) => !("apiEnabled" in user)));
  console.log("User access verification passed: fresh + upgrade migrations, legacy disabled API flags, key validity/scopes, create/update, bulk disable/re-enable, session revocation, final-admin guard, and DTOs.");
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
