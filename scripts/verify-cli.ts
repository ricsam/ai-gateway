#!/usr/bin/env bun
// End-to-end verification of aigctl against a fresh TimescaleDB database: runs
// the real CLI as separate processes in local mode (as inside the gateway
// container) and in remote mode against the management API over HTTP.
// Only the database this script creates is modified; never point it at DATABASE_URL.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (permission to create temporary databases)");
const suffix = crypto.randomUUID().replaceAll("-", "");
const databaseName = `aigctl_verify_${suffix}`;
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/aigctl-verify-");
const manifest = { runId: suffix, databases: [databaseName], paths: [scratch], cleanedUp: false };
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
const admin = new Pool({ connectionString: adminUrl });
const created: string[] = [];
let applicationPool: Pool | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

const databaseUrl = (() => { const url = new URL(adminUrl); url.pathname = `/${databaseName}`; return url.toString(); })();
// The gateway container's environment, as the Helm chart provides it.
const gatewayEnv = {
  DATABASE_URL: databaseUrl,
  BASE_URL: "http://gateway.verify.test",
  BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
  SETTINGS_ENCRYPTION_KEY: `v1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`,
};
const baseEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

interface Result { code: number; out: string; err: string }
async function cli(args: string[], options: { stdin?: string; env?: Record<string, string>; remote?: boolean } = {}): Promise<Result> {
  const child = Bun.spawn(["bun", "backend/cli/aigctl.ts", ...args], {
    env: { ...baseEnv, ...(options.remote ? {} : gatewayEnv), ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}
async function ok(args: string[], options?: Parameters<typeof cli>[1]): Promise<Result> {
  const result = await cli(args, options);
  assert.equal(result.code, 0, `aigctl ${args.join(" ")} failed (${result.code}): ${result.err}${result.out}`);
  return result;
}
async function fails(args: string[], code: number, message: string, options?: Parameters<typeof cli>[1]): Promise<Result> {
  const result = await cli(args, options);
  assert.equal(result.code, code, `aigctl ${args.join(" ")} exited ${result.code}, expected ${code}: ${result.err}${result.out}`);
  assert.ok(result.err.includes(message), `aigctl ${args.join(" ")}: expected "${message}" in: ${result.err}`);
  return result;
}
const json = async <T = any>(args: string[], options?: Parameters<typeof cli>[1]) => JSON.parse((await ok([...args, "-o", "json"], options)).out) as T;

try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created.push(databaseName);
  Object.assign(process.env, gatewayEnv);
  const { pool } = await import("../backend/db");
  applicationPool = pool;
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });

  // First boot without an open setup page.
  assert.equal((await ok(["setup", "status"])).out.trim(), "Setup is open: no user exists yet. Create the first administrator with 'aigctl setup init'.");
  await fails(["users", "create", "--username", "early", "--email", "early@example.test", "--generate-password"], 1, "Setup is still open");
  await fails(["setup", "init", "--username", "admin", "--email", "admin@example.test", "--password-stdin"], 1, "Password must be between 12 and 128 characters", { stdin: "short\n" });
  await ok(["setup", "init", "--username", "Admin", "--email", "Admin@Example.test", "--name", "Gateway Admin", "--password-stdin"], { stdin: "Admin-password-123\n" });
  await fails(["users", "set-password", "admin", "--password-stdin"], 1, "on a single line", { stdin: "Admin-password-123\nsecond line\n" });
  assert.equal((await json(["setup", "status"])).required, false);
  await fails(["setup", "init", "--username", "second", "--email", "second@example.test", "--generate-password"], 1, "Setup is already complete");
  const { auth } = await import("../backend/auth");
  const signIn = (username: string, password: string) => auth.api.signInUsername({ body: { username, password }, asResponse: true });
  assert.equal((await signIn("admin", "Admin-password-123")).status, 200, "the administrator signs in with the password set by aigctl");

  // Users, with lookups by username, email and ID.
  await ok(["groups", "create", "engineering", "--description", "Product engineering"]);
  const createdBob = await ok(["users", "create", "--username", "bob", "--email", "bob@example.test", "--name", "Bob Builder",
    "--monthly-credits", "50", "--balance", "12.5", "--group", "Engineering", "--generate-password"]);
  const bobPassword = createdBob.out.trim();
  assert.match(bobPassword, /^[A-Za-z0-9]{24}$/, "a generated password is the only standard output");
  assert.ok(createdBob.err.includes("bob must change the password at the first sign-in"));
  assert.equal((await signIn("bob", bobPassword)).status, 200, "the generated password works");
  await fails(["users", "create", "--username", "bob", "--email", "other@example.test", "--generate-password"], 1, "already exists");
  const bob = await json(["users", "get", "BOB@example.test"]);
  assert.deepEqual([bob.username, bob.mustChangePassword, bob.creditBalance, bob.defaultMonthlyCredits, bob.groups.map((group: { name: string }) => group.name)],
    ["bob", true, 12.5, 50, ["engineering"]]);
  assert.equal((await json(["users", "get", bob.id])).username, "bob");
  await ok(["users", "create", "--username", "test_user1", "--email", "t1@example.test", "--generate-password"]);
  await ok(["users", "create", "--username", "testxuser2", "--email", "t2@example.test", "--name", "Builder Two", "--generate-password"]);
  assert.deepEqual((await json(["users", "list", "--search", "test_"])).map((user: { username: string }) => user.username), ["test_user1"], "LIKE wildcards in a search are literal");
  assert.deepEqual((await json(["users", "list", "--search", "builder"])).map((user: { username: string }) => user.username), ["bob", "testxuser2"], "search covers display names");
  assert.match((await ok(["users", "list"])).out, /^bob\s+Bob Builder\s+bob@example\.test\s+user\s+yes\s+\$12\.50\s+\$50\.00\s+engineering$/m);
  await ok(["users", "update", "bob", "--balance", "20", "--role", "admin", "--must-change-password", "false"]);
  assert.deepEqual(await json(["users", "get", "bob"]).then((user) => [user.role, user.creditBalance, user.mustChangePassword]), ["admin", 20, false]);
  await ok(["users", "update", "bob", "--role", "user"]);
  await fails(["users", "disable", "admin"], 1, "Cannot remove or disable the final enabled administrator");
  await fails(["users", "delete", "admin"], 2, "pass --yes");
  await fails(["users", "delete", "admin", "--yes"], 1, "Cannot delete the final enabled administrator");
  await ok(["users", "set-password", "bob", "--password-stdin", "--must-change-password", "false"], { stdin: "Bob-new-password-1\n" });
  assert.equal((await signIn("bob", "Bob-new-password-1")).status, 200);
  assert.equal((await signIn("bob", bobPassword)).status, 401, "the previous password stops working");

  // Inference keys authenticate until the account is disabled or the key is revoked.
  const { authenticateApiKeyPrincipal } = await import("../backend/proxy-auth");
  const authenticate = (key: string) => authenticateApiKeyPrincipal(new Request("http://gateway.verify.test/v1/models", { headers: { authorization: `Bearer ${key}` } }));
  const inferenceKey = (await ok(["api-keys", "create", "bob", "--name", "laptop", "--scope", "ai.invoke,models.read"])).out.trim();
  assert.match(inferenceKey, /^aig_[0-9a-f]{64}$/);
  assert.equal((await authenticate(inferenceKey)).ok, true);
  await ok(["users", "disable", "bob"]);
  assert.equal((await authenticate(inferenceKey)).ok, false, "disabling the account blocks its keys");
  await ok(["users", "enable", "bob"]);
  assert.equal((await authenticate(inferenceKey)).ok, true);
  const rotated = (await ok(["api-keys", "create", "bob", "--name", "laptop", "--replace", "--expires", "30d"])).out.trim();
  assert.equal((await authenticate(inferenceKey)).ok, false, "--replace revokes the earlier key");
  assert.equal((await authenticate(rotated)).ok, true);
  assert.equal((await json(["api-keys", "list", "bob"])).length, 1);
  assert.equal((await json(["api-keys", "list", "bob", "--all"])).length, 2);
  await ok(["api-keys", "revoke", "bob", "laptop", "--yes"]);
  assert.equal((await authenticate(rotated)).ok, false);
  await fails(["api-keys", "revoke", "bob", "laptop", "--yes"], 1, "already revoked");

  // Groups.
  await ok(["groups", "create", "research"]);
  await fails(["groups", "create", "Research"], 1, "already exists", {});
  await ok(["groups", "add-member", "research", "bob", "test_user1", "--role", "admin"]);
  assert.deepEqual((await json(["groups", "get", "research"])).members.map((member: { username: string; role: string }) => `${member.username}:${member.role}`).sort(), ["bob:admin", "test_user1:admin"]);
  await ok(["groups", "set-role", "research", "bob", "owner"]);
  await ok(["groups", "remove-member", "research", "test_user1"]);
  await ok(["users", "set-groups", "testxuser2", "research", "engineering"]);
  assert.deepEqual((await json(["users", "get", "testxuser2"])).groups.map((group: { name: string }) => group.name).sort(), ["engineering", "research"]);
  assert.equal((await json(["groups", "bulk-update", "engineering", "research", "--monthly-credits", "75"])).usersUpdated, 2);
  await fails(["groups", "bulk-update", "research", "--disable"], 2, "pass --yes");
  await ok(["groups", "update", "research", "--name", "Research", "--description", "R&D"]);
  assert.equal((await json(["groups", "list"])).find((group: { name: string }) => group.name === "Research")?.description, "R&D");
  await ok(["groups", "delete", "Research", "--yes"]);

  // Credits and reporting.
  assert.equal((await json(["credits", "monthly-reset", "--yes"])).usersReset, 2);
  assert.equal((await json(["users", "get", "bob"])).creditBalance, 75);
  const events = await json(["usage", "events", "--user", "bob"]);
  assert.ok(events.some((event: { type: string }) => event.type === "monthly_reset"));
  assert.equal((await json(["usage", "summary", "--days", "7"])).requests, 0);
  assert.equal((await json(["analytics", "throughput", "--range", "day"])).summary.requests, 0);
  for (const command of [["analytics", "users"], ["analytics", "groups"], ["analytics", "models", "--group", "engineering"]]) await ok(command);

  // Settings, branding and AWS, with secrets from standard input.
  await ok(["settings", "set", "--remote-image-urls", "off"]);
  assert.equal((await json(["settings", "get"])).remoteImageUrlsEnabled, false);
  await ok(["branding", "set", "--product-name", "Acme AI", "--primary-color", "#0f766e"]);
  assert.equal((await json(["branding", "get"])).productName, "Acme AI");
  await ok(["aws", "set-credentials", "--access-key-id", "AKIAVERIFYEXAMPLE01", "--region", "eu-west-1", "--stdin"], { stdin: "verify-secret-access-key\n" });
  const aws = await json(["aws", "get"]);
  assert.deepEqual([aws.defaultRegion, aws.accessKeyId, aws.secretAccessKey.configured, aws.sessionToken.configured], ["eu-west-1", "AKIA…LE01", true, false]);
  const { getBedrockClient } = await import("../backend/bedrock");
  assert.equal(await (await getBedrockClient()).config.region(), "eu-west-1", "the stored credentials decrypt with SETTINGS_ENCRYPTION_KEY");
  await ok(["aws", "set-region", "us-east-1"]);
  assert.equal((await json(["aws", "get"])).accessKeyId, "AKIA…LE01", "changing the region keeps the credentials");
  await ok(["aws", "clear-credentials", "--yes"]);
  assert.equal((await json(["aws", "get"])).secretAccessKey.configured, false);

  // Login providers from JSON on standard input.
  const provider = JSON.stringify({ type: "trusted_header", providerKey: "proxy", label: "Corporate proxy",
    config: { subjectHeader: "x-user-id", emailHeader: "x-user-email", sourceCidrs: ["10.0.0.0/8"] }, secret: { operation: "replace", value: "shared-secret" } });
  await ok(["auth-providers", "create", "-f", "-"], { stdin: provider });
  await fails(["auth-providers", "enable", "proxy"], 1, "Test the provider successfully before enabling it");
  await ok(["auth-providers", "test", "proxy"]);
  await ok(["auth-providers", "enable", "proxy"]);
  assert.equal((await json(["auth-providers", "get", "proxy"])).enabled, true);
  await ok(["auth-providers", "update", "proxy", "-f", "-"], { stdin: JSON.stringify({ label: "Corp proxy" }) });
  await ok(["auth-providers", "delete", "proxy", "--yes"]);

  // The model catalog: what API clients see at /v1/models, checked with an inference key.
  const { handleListModels } = await import("../backend/public-api");
  const catalogKey = (await ok(["api-keys", "create", "bob", "--name", "catalog", "--scope", "models.read"])).out.trim();
  const publicModels = async () => {
    const response = await handleListModels(new Request("http://gateway.verify.test/v1/models", { headers: { authorization: `Bearer ${catalogKey}` } }));
    assert.equal(response.status, 200);
    return ((await response.json()) as { data: { id: string }[] }).data.map((entry) => entry.id).sort();
  };
  /** Each listed ID's name and efforts, by ID. */
  const listedFields = async () => {
    const response = await handleListModels(new Request("http://gateway.verify.test/v1/models", { headers: { authorization: `Bearer ${catalogKey}` } }));
    const entries = ((await response.json()) as { data: Record<string, unknown>[] }).data;
    return Object.fromEntries(entries.map(({ id, object, created, owned_by, ...fields }) => [id, fields]));
  };
  assert.deepEqual(await publicModels(), []);
  await ok(["models", "create", "--model-id", "us.anthropic.claude-opus-4-6-v1", "--name", "Claude Opus 4.6", "--input-price", "5", "--output-price", "25",
    "--cache-read-price", "0.5", "--thinking", "on", "--max-output-tokens", "128000"]);
  await ok(["models", "create", "--model-id", "amazon.nova-pro-v1:0", "--name", "Nova Pro", "--input-price", "0.8", "--output-price", "3.2", "--region", "us-west-2", "--disabled"]);
  await fails(["models", "create", "--model-id", "amazon.nova-pro-v1:0", "--name", "Again", "--input-price", "1", "--output-price", "1"], 1, "Public model ID 'amazon.nova-pro-v1:0' is already in use");
  const nova = await json(["models", "get", "nova pro"]);
  assert.deepEqual([nova.enabled, nova.available, nova.region, nova.inputPricePerMTok], [false, false, "us-west-2", 0.8]);
  await ok(["models", "update", "Nova Pro", "--region", "default", "--context-window", "300000", "--description", "Amazon Nova Pro"]);
  await ok(["models", "enable", "amazon.nova-pro-v1:0"]);
  assert.deepEqual(await json(["models", "get", "Nova Pro"]).then((model) => [model.available, model.region, model.contextWindow, model.description]), [true, null, 300000, "Amazon Nova Pro"]);
  await fails(["aliases", "create", "opus-off", "--upstream", "Claude Opus 4.6", "--thinking", "on"], 1, "Choose an effort level when thinking is enabled");
  await ok(["aliases", "create", "opus-max", "--upstream", "us.anthropic.claude-opus-4-6-v1", "--thinking", "on", "--effort", "max", "--name", "Opus max"]);
  await ok(["aliases", "create", "nova-client", "--upstream", "Nova Pro", "--reasoning", "client"]);
  await fails(["aliases", "create", "us.anthropic.claude-opus-4-6-v1", "--upstream", "Nova Pro"], 1, "Public model ID 'us.anthropic.claude-opus-4-6-v1' is already in use");
  await fails(["aliases", "create", "amazon.nova-pro-v1:0", "--upstream", "Nova Pro"], 2, "The alias must be 1-128 lowercase letters, digits, dots, underscores or hyphens");
  await ok(["apps", "create", "chat-app", "--map", "max=opus-max", "--map", "low=nova-client"]);
  assert.deepEqual(await publicModels(), ["amazon.nova-pro-v1:0", "chat-app-low", "chat-app-max", "nova-client", "opus-max", "us.anthropic.claude-opus-4-6-v1"],
    "models, aliases and mapped app tiers are public; unmapped tiers are not");
  // /v1/models names each ID and lists the efforts it takes: Claude Opus 4.6's are none to max without xhigh, a
  // model without reasoning takes none, a pinned alias and its app tiers list the effort they run at instead.
  const opusEfforts = ["none", "low", "medium", "high", "max"];
  assert.deepEqual(await listedFields(), {
    "amazon.nova-pro-v1:0": { name: "Nova Pro", efforts: [], default_effort: null },
    "chat-app-low": { name: "chat-app / low", efforts: [], default_effort: null },
    "chat-app-max": { name: "chat-app / max", efforts: [], default_effort: null, effort: "max" },
    "nova-client": { name: "nova-client", efforts: [], default_effort: null },
    "opus-max": { name: "Opus max", efforts: [], default_effort: null, effort: "max" },
    "us.anthropic.claude-opus-4-6-v1": { name: "Claude Opus 4.6", efforts: opusEfforts, default_effort: null },
  });
  await ok(["models", "update", "Claude Opus 4.6", "--default-effort", "xhigh"]);
  await ok(["aliases", "update", "nova-client", "--name", "Nova Pro (client)"]);
  const renamed = await listedFields();
  assert.deepEqual(renamed["us.anthropic.claude-opus-4-6-v1"], { name: "Claude Opus 4.6", efforts: opusEfforts, default_effort: "high" },
    "a default effort is listed as the level the model runs it at");
  assert.equal(renamed["nova-client"]?.name, "Nova Pro (client)", "an alias's new name is listed at once");
  await ok(["models", "update", "Claude Opus 4.6", "--default-effort", "default"]);
  const app = await json(["apps", "get", "chat-app"]);
  assert.deepEqual(app.tiers.map((tier: { modelId: string; available: boolean }) => `${tier.modelId}:${tier.available}`),
    ["chat-app-min:false", "chat-app-low:true", "chat-app-medium:false", "chat-app-high:false", "chat-app-max:true"]);
  await ok(["apps", "set-tier", "chat-app", "high", "opus-max"]);
  await ok(["apps", "set-tier", "chat-app", "low", "-"]);
  await ok(["apps", "remove-tier", "chat-app", "min", "--yes"]);
  await ok(["aliases", "update", "opus-max", "--effort", "high"]);
  assert.equal((await json(["aliases", "get", "opus-max"])).effort, "high");
  const opus = await json(["models", "get", "Claude Opus 4.6"]);
  const catalogAudits = async () => (await json<{ action: string }[]>(["audit", "list", "--limit", "1000"])).filter((event) => /^(model|alias|app)\./.test(event.action)).length;
  const auditsBefore = await catalogAudits();
  for (const path of [`/models/${opus.id}`, `/model-aliases/${(await json(["aliases", "get", "opus-max"])).id}`, `/model-apps/${app.id}`]) {
    assert.equal(JSON.parse((await ok(["api", "PATCH", path, "-d", "{}"])).out).data.id, path.split("/")[2], `an empty PATCH of ${path} returns the entry`);
  }
  assert.equal(await catalogAudits(), auditsBefore, "empty PATCHes write no audit events");
  const tooLarge = await cli(["api", "PATCH", `/models/${opus.id}`, "-d", "{\"inputPricePerMTok\": 1e15}"]);
  assert.equal(tooLarge.code, 1);
  assert.match(JSON.parse(tooLarge.out).error.message, /^inputPricePerMTok: Too big/);
  const duplicateTiers = await cli(["api", "PATCH", `/model-apps/${app.id}`, "-d", JSON.stringify({ tiers: [{ name: "max", aliasId: null }, { name: "max", aliasId: null }] })]);
  assert.equal(JSON.parse(duplicateTiers.out).error.message, "tiers: tier names must be unique");
  await ok(["models", "disable", "Claude Opus 4.6"]);
  assert.deepEqual(await publicModels(), ["amazon.nova-pro-v1:0", "nova-client"], "disabling a model hides its aliases and their tiers too");
  assert.equal((await json(["aliases", "get", "opus-max"])).available, false);
  await ok(["models", "enable", "Claude Opus 4.6"]);
  await fails(["models", "update", "Claude Opus 4.6", "--thinking", "off"], 1, "Alias 'opus-max' would become invalid");
  await fails(["models", "delete", "Claude Opus 4.6", "--yes"], 1, "referenced by alias 'opus-max'");
  await fails(["aliases", "delete", "opus-max", "--yes"], 1, "referenced by app 'chat-app'");
  await ok(["apps", "update", "chat-app", "--name", "chat"]);
  assert.deepEqual(await publicModels(), ["amazon.nova-pro-v1:0", "chat-high", "chat-max", "nova-client", "opus-max", "us.anthropic.claude-opus-4-6-v1"]);
  await ok(["apps", "delete", "chat", "--yes"]);
  await ok(["aliases", "delete", "nova-client", "--yes"]);
  await ok(["models", "delete", "Nova Pro", "--yes"]);
  assert.deepEqual(await publicModels(), ["opus-max", "us.anthropic.claude-opus-4-6-v1"]);

  // Remote mode: the same commands over HTTP with a management key.
  const { handleManagementApi } = await import("../backend/management-api");
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handleManagementApi(request) });
  const remoteEnv = (key: string) => ({ AI_GATEWAY_URL: `http://127.0.0.1:${server!.port}`, AI_GATEWAY_MANAGEMENT_KEY: key });
  const readKey = (await ok(["management-keys", "create", "--name", "verify-read", "--scope", "*.read", "--expires", "1d"])).out.trim();
  assert.match(readKey, /^aigm_[0-9a-f]{64}$/);
  const remoteUsers = await json<{ username: string }[]>(["users", "list"], { remote: true, env: remoteEnv(readKey) });
  assert.deepEqual(remoteUsers.map((user) => user.username), ["admin", "bob", "test_user1", "testxuser2"], "remote mode needs no database environment");
  await fails(["users", "disable", "bob"], 1, "Required scope: users.write", { remote: true, env: remoteEnv(readKey) });
  await fails(["setup", "status"], 1, "runs only inside the gateway container", { remote: true, env: remoteEnv(readKey) });
  const writeKey = (await ok(["management-keys", "create", "--name", "verify-write", "--scope", "users.*"])).out.trim();
  await ok(["users", "update", "bob", "--name", "Robert"], { remote: true, env: remoteEnv(writeKey) });
  await ok(["management-keys", "revoke", "verify-write", "--yes"]);
  await fails(["users", "list"], 1, "Invalid, expired, or revoked management key", { remote: true, env: remoteEnv(writeKey) });
  await fails(["users", "list"], 1, "inference keys (aig_...) cannot use the management API", { remote: true, env: remoteEnv(rotated) });
  assert.equal(JSON.parse((await ok(["api", "GET", "/users?search=robert"], { remote: true, env: remoteEnv(readKey) })).out).data[0].username, "bob");
  assert.deepEqual((await json<{ modelId: string }[]>(["aliases", "list"], { remote: true, env: remoteEnv(readKey) })).map((alias) => alias.modelId), ["opus-max"]);
  await fails(["aliases", "disable", "opus-max"], 1, "Required scope: models.write", { remote: true, env: remoteEnv(readKey) });
  const catalogWriteKey = (await ok(["management-keys", "create", "--name", "verify-models", "--scope", "models.*", "--expires", "1d"])).out.trim();
  await ok(["apps", "create", "remote-app", "--tiers", "max", "--map", "max=opus-max"], { remote: true, env: remoteEnv(catalogWriteKey) });
  assert.deepEqual(await publicModels(), ["opus-max", "remote-app-max", "us.anthropic.claude-opus-4-6-v1"], "remote changes reach /v1/models at once");
  await ok(["apps", "delete", "remote-app", "--yes"], { remote: true, env: remoteEnv(catalogWriteKey) });

  // Values that users control never reach the terminal as escape sequences.
  await ok(["--actor", "richard", "users", "update", "testxuser2", "--name", "Two \u001b]0;pwned\u0007\u001b[2J\u009b31m"]);
  for (const output of [await ok(["users", "get", "testxuser2"]), await ok(["users", "list"]), await ok(["users", "get", "testxuser2", "-o", "json"])]) {
    assert.doesNotMatch(output.out, /[\u001b\u0007\u009b]/, "control characters are escaped");
  }
  assert.equal((await json(["users", "get", "testxuser2"])).name, "Two \u001b]0;pwned\u0007\u001b[2J\u009b31m", "JSON keeps the exact value");

  // Changes are audited: locally as the pod's aigctl, remotely as the key.
  const audit = await json<{ action: string; actorType: string; actorId: string | null; metadata: Record<string, unknown> }[]>(["audit", "list", "--limit", "200"]);
  const hostname = (await import("node:os")).hostname();
  assert.ok(audit.some((event) => event.action === "user.created" && event.actorType === "cli" && event.actorId === `aigctl@${hostname}`));
  assert.ok(audit.some((event) => event.action === "user.updated" && event.actorType === "cli" && event.actorId === `richard via aigctl@${hostname}`), "--actor is recorded");
  assert.ok(audit.some((event) => event.action === "installation.setup.completed" && event.metadata.via === `aigctl@${hostname}`));
  assert.ok(audit.some((event) => event.action === "user.updated" && event.actorType === "management_key"));
  assert.ok(audit.some((event) => event.action === "model.created" && event.actorType === "cli" && event.metadata.modelId === "us.anthropic.claude-opus-4-6-v1"));
  assert.ok(audit.some((event) => event.action === "app.created" && event.actorType === "management_key" && event.metadata.name === "remote-app"));
  assert.ok(audit.some((event) => event.action === "alias.deleted" && event.metadata.modelId === "nova-client"), "deleted entries keep their name in the audit log");
  assert.ok(!JSON.stringify(audit).includes("verify-secret-access-key") && !JSON.stringify(audit).includes("Bob-new-password-1"), "no secret reaches the audit log");
  assert.match((await ok(["audit", "list", "--limit", "200"])).out, /user\.created\s+cli aigctl@\S+\s+user bob\s/, "the table names users");

  await fails(["users", "list"], 1, "DATABASE_URL, BASE_URL, BETTER_AUTH_SECRET, SETTINGS_ENCRYPTION_KEY are not set", { remote: true });
  await fails(["users", "list"], 1, "Could not connect to the gateway database", { env: { DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none" } });
  const emptyName = `${databaseName}_empty`;
  await admin.query(`CREATE DATABASE "${emptyName}"`);
  created.push(emptyName);
  const emptyUrl = new URL(databaseUrl);
  emptyUrl.pathname = `/${emptyName}`;
  await fails(["setup", "status"], 1, "has no tables yet: run the migrations first", { env: { DATABASE_URL: emptyUrl.toString() } });
  console.log("aigctl verification passed: first-boot setup, users and passwords (sign-in checked), inference keys (authentication checked), groups, credits, reports, settings, branding, AWS secrets, login providers, models, aliases and apps (checked through /v1/models), remote mode with scoped and revoked management keys, audit actors, terminal-safe output, and environment errors.");
} finally {
  server?.stop(true);
  await applicationPool?.end();
  try {
    for (const name of created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    manifest.cleanedUp = true;
    await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  } finally { await admin.end(); }
  if (manifest.cleanedUp) await rm(scratch, { recursive: true, force: true });
  else console.log(`Cleanup incomplete; resource manifest: ${scratch}/manifest.json`);
  console.log(`Dropped ${created.join(", ") || "no databases"}.`);
}
