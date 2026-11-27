import { describe, expect, test } from "bun:test";
import { call, createClient, localPrincipal, managementRequest, parseActor, parseServerUrl, RemoteClient, type ManagementClient, type RequestOptions } from "./client";
import { argumentBounds, locate, runProgram } from "./framework";
import { expandScopes, generatePassword, parseAmount, parseBoolean, parseExpiry } from "./inputs";
import type { Io } from "./io";
import { formatValue, printJson, renderDetails, renderTable, terminalSafe } from "./output";
import { program } from "./program";
import { findKey, keyStatus, type Alias, type App, type Model, type User } from "./resources";

interface RecordedRequest { method: string; path: string; query: Record<string, string>; search: URLSearchParams; json: unknown; contentType: string | null; bytes?: Uint8Array }
type Handler = (request: RecordedRequest) => { status?: number; body?: unknown } | undefined;

/** A management API double: routes are "METHOD /path" (without the query string). */
class FakeClient implements ManagementClient {
  readonly mode: "local" | "remote";
  readonly target = "fake gateway";
  readonly requests: RecordedRequest[] = [];
  closed = false;
  constructor(private readonly routes: Record<string, Handler>, mode: "local" | "remote" = "remote") { this.mode = mode; }
  async send(method: string, path: string, options?: RequestOptions): Promise<Response> {
    const request = managementRequest("http://fake.test", method, path, options);
    const url = new URL(request.url);
    const contentType = request.headers.get("content-type");
    const recorded: RecordedRequest = {
      method, path: url.pathname.replace(/^\/management\/v1/, ""), query: Object.fromEntries(url.searchParams), search: url.searchParams,
      json: options?.json ?? (options?.bytes && contentType === "application/json" ? JSON.parse(new TextDecoder().decode(options.bytes)) : undefined),
      contentType, bytes: options?.bytes,
    };
    this.requests.push(recorded);
    const result = this.routes[`${method} ${recorded.path}`]?.(recorded);
    if (!result) return Response.json({ error: { code: "not_found", message: `No route for ${method} ${recorded.path}` } }, { status: 404 });
    return Response.json(result.body ?? { success: true }, { status: result.status ?? 200 });
  }
  async close() { this.closed = true; }
  mutations() { return this.requests.filter((request) => request.method !== "GET"); }
}

function fakeIo(options: { interactive?: boolean; answers?: string[]; stdin?: string | Uint8Array; files?: Record<string, Uint8Array> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: { question: string; hidden: boolean }[] = [];
  const answers = [...(options.answers ?? [])];
  const io: Io = {
    env: {}, hostname: "gateway-pod-1", interactive: options.interactive ?? false,
    out: (text) => { out.push(text); },
    err: (text) => { err.push(text); },
    prompt: async (question, promptOptions) => {
      prompts.push({ question, hidden: promptOptions?.hidden ?? false });
      if (!answers.length) throw new Error(`Unexpected prompt: ${question}`);
      return answers.shift()!;
    },
    readStdin: async () => typeof options.stdin === "string" ? new TextEncoder().encode(options.stdin) : options.stdin ?? new Uint8Array(),
    readFile: async (path) => {
      const file = options.files?.[path];
      if (!file) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      return file;
    },
    flush: async () => {},
  };
  return { io, out: () => out.join(""), err: () => err.join(""), prompts };
}

async function run(argv: string[], client: FakeClient, ioOptions: Parameters<typeof fakeIo>[0] = {}) {
  const io = fakeIo(ioOptions);
  const code = await runProgram(program, argv, { io: io.io, createClient: async () => client });
  return { code, out: io.out(), err: io.err(), prompts: io.prompts };
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: "u-bob", username: "bob", name: "Bob Builder", email: "bob@example.com", role: "user", enabled: true,
    mustChangePassword: false, creditBalance: 12.5, defaultMonthlyCredits: 50, createdAt: "2026-11-16T10:00:00.000Z",
    groups: [{ id: "g-eng", name: "engineering", role: "member" }], ...overrides,
  };
}

const page = <T>(data: T[]) => ({ body: { data, pagination: { limit: 100, offset: 0, total: data.length } } });

/** Routes that resolve "bob" by username, as the API does: GET /users/bob is a 404, then a search. */
function userRoutes(target = user()): Record<string, Handler> {
  return {
    [`GET /users/${target.id}`]: () => ({ body: { data: target } }),
    "GET /users": (request) => page([target].filter((candidate) => !request.query.search || candidate.username.includes(request.query.search.toLowerCase()) || candidate.email.includes(request.query.search.toLowerCase()))),
  };
}

describe("argument parsing", () => {
  test("finds the command path with global options before it", () => {
    const invocation = locate(["-o", "json", "--server", "https://gw.example.com", "users", "list", "--search", "bob"], program.entries);
    expect(invocation.path).toEqual(["users", "list"]);
    expect(invocation.command?.name).toBe("list");
    expect(invocation.rest).toEqual(["-o", "json", "--server", "https://gw.example.com", "--search", "bob"]);
  });

  test("counts positional arguments from usage", () => {
    expect(argumentBounds(undefined)).toEqual({ min: 0, max: 0 });
    expect(argumentBounds("<user>")).toEqual({ min: 1, max: 1 });
    expect(argumentBounds("<user> [group...]")).toEqual({ min: 1, max: Infinity });
    expect(argumentBounds("<group> <user>...")).toEqual({ min: 2, max: Infinity });
    expect(argumentBounds("[bedrock-model-id]")).toEqual({ min: 0, max: 1 });
  });

  test("prints help without creating a client", async () => {
    const client = new FakeClient({});
    const overview = await run([], client);
    expect(overview.code).toBe(0);
    expect(overview.out).toContain("kubectl exec -it deploy/<release>-ai-gateway -- aigctl users list");
    const group = await run(["users"], client);
    expect(group.out).toContain("set-password");
    const command = await run(["users", "create", "--help"], client);
    expect(command.code).toBe(0);
    expect(command.out).toContain("--password-stdin");
    const viaHelp = await run(["help", "api-keys", "create"], client);
    expect(viaHelp.out).toContain("aigctl api-keys create <user>");
    expect(client.requests).toHaveLength(0);
  });

  test("reports unknown commands and options with exit code 2", async () => {
    const client = new FakeClient({});
    const unknown = await run(["user", "list"], client);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("Did you mean 'users'?");
    const root = await run(["--bogus"], client);
    expect(root.code).toBe(2);
    expect(root.out).toBe("");
    expect(root.err).toContain("Unknown option '--bogus'");
    const missingCommand = await run(["-o", "json"], client);
    expect(missingCommand.code).toBe(2);
    expect(missingCommand.err).toContain("Missing command");
    const option = await run(["users", "list", "--bogus"], client);
    expect(option.code).toBe(2);
    expect(option.err).toContain("Unknown option '--bogus'");
    expect(option.err).toContain("Run 'aigctl users list --help' for usage.");
    const missing = await run(["users", "get"], client);
    expect(missing.code).toBe(2);
    const output = await run(["users", "list", "-o", "yaml"], client);
    expect(output.code).toBe(2);
    expect(output.err).toContain("--output must be one of table, wide, json");
  });
});

describe("input parsing", () => {
  test("parses expiries as durations or dates in the future", () => {
    const now = new Date("2026-11-16T12:00:00.000Z");
    expect(parseExpiry("30d", now)).toBe("2026-12-16T12:00:00.000Z");
    expect(parseExpiry("12h", now)).toBe("2026-11-17T00:00:00.000Z");
    expect(parseExpiry("2w", now)).toBe("2026-11-30T12:00:00.000Z");
    expect(parseExpiry("2027-01-31", now)).toBe("2027-01-31T00:00:00.000Z");
    expect(() => parseExpiry("2020-01-01", now)).toThrow("in the future");
    expect(() => parseExpiry("tomorrow", now)).toThrow("duration");
  });

  test("expands scope patterns in the canonical order", () => {
    const scopes = ["users.read", "users.write", "groups.read", "audit.read"];
    expect(expandScopes(["users.*"], scopes)).toEqual(["users.read", "users.write"]);
    expect(expandScopes(["*.read", "users.write"], scopes)).toEqual(["users.read", "users.write", "groups.read", "audit.read"]);
    expect(expandScopes(["*"], scopes)).toEqual(scopes);
    expect(() => expandScopes(["users.admin"], scopes)).toThrow("Unknown scope 'users.admin'");
    expect(() => expandScopes(["models.*"], scopes)).toThrow("matches no scope");
  });

  test("parses booleans and amounts", () => {
    expect(parseBoolean("x", "off")).toBe(false);
    expect(parseBoolean("x", "YES")).toBe(true);
    expect(() => parseBoolean("x", "maybe")).toThrow("--x must be true or false");
    expect(parseAmount("balance", "$12.50")).toBe(12.5);
    expect(() => parseAmount("balance", "-1")).toThrow("non-negative");
  });

  test("generates passwords the gateway accepts", () => {
    for (let index = 0; index < 50; index++) {
      const password = generatePassword();
      expect(password).toHaveLength(24);
      expect(password).toMatch(/^[A-Za-z0-9]+$/);
      expect(password).toMatch(/[a-z]/i);
      expect(password).toMatch(/\d/);
    }
  });
});

describe("output", () => {
  test("aligns columns, hides wide columns and truncates long cells", () => {
    const rows = [{ name: "alice", balance: "$1.00", note: "x".repeat(30) }, { name: "bob", balance: "$120.50", note: null }];
    const columns = [
      { header: "NAME", value: (row: typeof rows[number]) => row.name },
      { header: "BALANCE", value: (row: typeof rows[number]) => row.balance, align: "right" as const },
      { header: "NOTE", value: (row: typeof rows[number]) => row.note, maxWidth: 10 },
      { header: "ID", value: () => "id-1", wide: true },
    ];
    expect(renderTable(rows, columns)).toBe([
      "NAME    BALANCE   NOTE",
      "alice     $1.00   xxxxxxxxx…",
      "bob     $120.50   -",
      "",
    ].join("\n"));
    expect(renderTable(rows, columns, true).split("\n")[0]).toBe("NAME    BALANCE   NOTE                             ID");
  });

  test("formats values and details", () => {
    expect(formatValue(true)).toBe("yes");
    expect(formatValue(null)).toBe("-");
    expect(formatValue(["a", "b"])).toBe("a, b");
    expect(renderDetails([["Name", "bob"], ["Enabled", false]])).toBe("Name:    bob\nEnabled: no\n");
  });

  test("never writes terminal control sequences from data", () => {
    const hostile = "Eve\u001b]0;pwned\u0007\u001b[2J\u009b31m\u202eevil";
    expect(terminalSafe(hostile)).toBe("Eve\\u001b]0;pwned\\u0007\\u001b[2J\\u009b31m\\u202eevil");
    expect(formatValue(hostile)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
    expect(renderDetails([["Config", `{\n  "a": "${hostile}"\n}`]])).not.toMatch(/[\u001b\u0007\u009b]/);
    expect(terminalSafe("tabs\tand\nlines stay")).toBe("tabs\tand\nlines stay");
    const io = fakeIo();
    printJson(io.io, { name: "x\u009by\u202e" });
    expect(JSON.parse(io.out())).toEqual({ name: "x\u009by\u202e" });
    expect(io.out()).not.toMatch(/[\u009b\u202e]/);
  });
});

describe("key lookup", () => {
  const keys = [
    { id: "k1", name: "ci", keyPrefix: "aig_111111111", enabled: false, expiresAt: null, revokedAt: "2026-01-01T00:00:00Z" },
    { id: "k2", name: "ci", keyPrefix: "aig_222222222", enabled: true, expiresAt: null, revokedAt: null },
    { id: "k3", name: "old", keyPrefix: "aig_333333333", enabled: true, expiresAt: "2020-01-01T00:00:00Z", revokedAt: null },
  ];
  test("finds keys by ID, prefix or unique unrevoked name", () => {
    expect(findKey(keys, "k3", "key").id).toBe("k3");
    expect(findKey(keys, "aig_111111111", "key").id).toBe("k1");
    expect(findKey(keys, "ci", "key").id).toBe("k2");
    expect(() => findKey(keys, "nope", "key")).toThrow("No key");
    expect(keyStatus(keys[0]!)).toBe("revoked");
    expect(keyStatus(keys[2]!)).toBe("expired");
  });
});

describe("commands", () => {
  test("lists users as a table and as JSON", async () => {
    const client = new FakeClient(userRoutes());
    const table = await run(["users", "list"], client);
    expect(table.code).toBe(0);
    expect(table.out).toContain("USERNAME   NAME          EMAIL");
    expect(table.out).toContain("bob        Bob Builder   bob@example.com   user   yes        $12.50    $50.00   engineering");
    const json = await run(["users", "list", "-o", "json"], client);
    expect(JSON.parse(json.out)).toEqual([user()]);
    expect(client.closed).toBe(true);
  });

  test("resolves a username and disables the user", async () => {
    const client = new FakeClient({ ...userRoutes(), "POST /users/u-bob/disable": () => ({ body: { data: user({ enabled: false }) } }) });
    const result = await run(["users", "disable", "bob"], client);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Disabled bob");
    expect(client.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /users/bob", "GET /users", "POST /users/u-bob/disable", "GET /users/u-bob",
    ]);
    expect(client.requests[1]!.query.search).toBe("bob");
  });

  test("refuses destructive changes without a terminal or --yes", async () => {
    const client = new FakeClient({ ...userRoutes(), "DELETE /users/u-bob": () => ({ body: { success: true } }) });
    const refused = await run(["users", "delete", "bob"], client);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("pass --yes");
    expect(client.mutations()).toHaveLength(0);
    const declined = await run(["users", "delete", "bob"], client, { interactive: true, answers: ["n"] });
    expect(declined.code).toBe(1);
    expect(client.mutations()).toHaveLength(0);
    const confirmed = await run(["users", "delete", "bob"], client, { interactive: true, answers: ["y"] });
    expect(confirmed.code).toBe(0);
    expect(confirmed.prompts[0]!.question).toBe("Delete user bob (bob@example.com)? [y/N] ");
    expect(client.mutations().map((request) => request.path)).toEqual(["/users/u-bob"]);
  });

  test("creates a user with a generated password on standard output only", async () => {
    let created: unknown;
    const client = new FakeClient({
      "GET /users": () => page([]),
      "GET /groups/engineering": () => undefined,
      "GET /groups": () => page([{ id: "g-eng", name: "engineering", description: null, createdAt: "2026-11-16T10:00:00.000Z" }]),
      "POST /users": (request) => { created = request.json; return { status: 201, body: { data: user({ id: "u-new", username: "alice" }) } }; },
      "GET /users/u-new": () => ({ body: { data: user({ id: "u-new", username: "alice", mustChangePassword: true }) } }),
    });
    const result = await run(["users", "create", "--username", "alice", "--email", "alice@example.com", "--group", "Engineering", "--monthly-credits", "25", "--generate-password"], client);
    expect(result.code).toBe(0);
    const password = result.out.trim();
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(result.err).toContain("Created user alice (u-new)");
    expect(created).toEqual({
      username: "alice", email: "alice@example.com", name: "alice", password, role: "user", enabled: true,
      mustChangePassword: true, defaultMonthlyCredits: 25, groupIds: ["g-eng"],
    });
  });

  test("asks for a password twice on a terminal and checks the policy first", async () => {
    const routes: Record<string, Handler> = { ...userRoutes(), "POST /users/u-bob/password": () => ({ body: { success: true } }) };
    const client = new FakeClient(routes);
    const result = await run(["users", "set-password", "bob"], client, { interactive: true, answers: ["New-password-123", "New-password-123"] });
    expect(result.code).toBe(0);
    expect(result.prompts.every((prompt) => prompt.hidden)).toBe(true);
    expect(client.mutations()[0]!.json).toEqual({ password: "New-password-123", mustChangePassword: true });
    const weak = await run(["users", "set-password", "bob"], client, { interactive: true, answers: ["short"] });
    expect(weak.code).toBe(1);
    expect(weak.err).toContain("Password must be between 12 and 128 characters");
    expect(weak.prompts).toHaveLength(1);
    const piped = await run(["users", "set-password", "bob"], client);
    expect(piped.code).toBe(2);
    expect(piped.err).toContain("--password-stdin");
    const twoLines = await run(["users", "set-password", "bob", "--password-stdin"], client, { stdin: "First-password-123\nsecond line\n" });
    expect(twoLines.code).toBe(1);
    expect(twoLines.err).toContain("on a single line");
    const onTerminal = await run(["users", "set-password", "bob", "--password-stdin"], client, { interactive: true, stdin: "Typed-password-123\n" });
    expect(onTerminal.code).toBe(2);
    expect(onTerminal.err).toContain("leave out --password-stdin to be asked without echo");
    const piped2 = await run(["users", "set-password", "bob", "--password-stdin"], client, { stdin: "Piped-password-123\n" });
    expect(piped2.code).toBe(0);
    expect(client.mutations().map((request) => (request.json as { password: string }).password)).toEqual(["New-password-123", "Piped-password-123"]);
  });

  test("prints a created inference key alone on standard output", async () => {
    const client = new FakeClient({
      ...userRoutes(),
      "POST /users/u-bob/api-keys": (request) => ({ status: 201, body: { data: {
        id: "k1", userId: "u-bob", name: "laptop", keyPrefix: "aig_abcdef123", scopes: (request.json as { scopes: string[] }).scopes,
        enabled: true, expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: "2026-11-16T10:00:00.000Z", key: "aig_abcdef1234567890",
      } } }),
    });
    const result = await run(["api-keys", "create", "bob", "--name", "laptop", "--scope", "ai.invoke,models.read"], client);
    expect(result.code).toBe(0);
    expect(result.out).toBe("aig_abcdef1234567890\n");
    expect(result.err).toContain("Created inference key 'laptop' for bob (ai.invoke, models.read; expires never)");
    expect(client.mutations()[0]!.json).toEqual({ name: "laptop", scopes: ["ai.invoke", "models.read"], replaceExisting: false });
  });

  test("expands management key scope patterns", async () => {
    const client = new FakeClient({
      "POST /management-keys": (request) => ({ status: 201, body: { data: {
        id: "m1", name: "ci", keyPrefix: "aigm_12345678", scopes: (request.json as { scopes: string[] }).scopes, expiresAt: null,
        revokedAt: null, lastUsedAt: null, createdByUserId: null, createdAt: "2026-11-16T10:00:00.000Z", key: "aigm_secret",
      } } }),
    });
    const result = await run(["management-keys", "create", "--name", "ci", "--scope", "users.*", "--scope", "audit.read"], client);
    expect(result.code).toBe(0);
    expect(result.out).toBe("aigm_secret\n");
    expect((client.mutations()[0]!.json as { scopes: string[] }).scopes).toEqual(["users.read", "users.write", "audit.read"]);
  });

  test("sends the current revision with settings changes", async () => {
    const client = new FakeClient({
      "GET /settings": () => ({ body: { data: { revision: 7, remoteImageUrlsEnabled: true, reasoningReplayEnabled: true } } }),
      "PUT /settings": () => ({ body: { data: { revision: 8, remoteImageUrlsEnabled: true, reasoningReplayEnabled: false } } }),
    });
    const result = await run(["settings", "set", "--reasoning-replay", "off"], client);
    expect(result.code).toBe(0);
    expect(client.mutations()[0]!.json).toEqual({ revision: 7, reasoningReplayEnabled: false });
    expect(result.out).toContain("Stored reasoning was deleted.");
  });

  test("stores AWS credentials from standard input and keeps the region", async () => {
    const aws = { revision: 3, defaultRegion: "eu-west-1", accessKeyId: null, secretAccessKey: { configured: false }, sessionToken: { configured: false } };
    const client = new FakeClient({ "GET /aws": () => ({ body: { data: aws } }), "PUT /aws": () => ({ body: { data: aws } }) });
    const result = await run(["aws", "set-credentials", "--access-key-id", "AKIAEXAMPLE", "--stdin"], client, { stdin: "the-secret\n" });
    expect(result.code).toBe(0);
    expect(client.mutations()[0]!.json).toEqual({
      revision: 3, defaultRegion: "eu-west-1", accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: { operation: "replace", value: "the-secret" }, sessionToken: { operation: "clear" },
    });
  });

  test("uploads an image with its detected content type", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
    const client = new FakeClient({ "POST /branding/assets/logo": () => ({ status: 201, body: { data: { kind: "logo", digest: "d", url: "/api/branding/assets/logo/d" } } }) });
    const result = await run(["branding", "upload", "logo", "-"], client, { stdin: png });
    expect(result.code).toBe(0);
    expect(client.requests[0]!.contentType).toBe("image/png");
    expect(client.requests[0]!.bytes).toEqual(png);
  });

  test("api prints the response and fails on errors", async () => {
    const client = new FakeClient({ "POST /groups": (request) => ({ status: 201, body: { data: { name: (request.json as { name?: string } | undefined)?.name ?? null } } }) });
    const created = await run(["api", "post", "/management/v1/groups", "-d", "{\"name\":\"ops\"}"], client);
    expect(created.code).toBe(0);
    expect(JSON.parse(created.out)).toEqual({ data: { name: "ops" } });
    expect(client.requests[0]!.contentType).toBe("application/json");
    const missing = await run(["api", "GET", "/nope"], client);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).error.code).toBe("not_found");
    expect(missing.err).toContain("answered HTTP 404");
  });

  test("setup refuses to run against a remote gateway", async () => {
    const result = await run(["setup", "status"], new FakeClient({}, "remote"));
    expect(result.code).toBe(1);
    expect(result.err).toContain("runs only inside the gateway container");
  });
});

const MODEL_ID = "7d0f3f5e-9a1f-4b8e-8f0e-2f3c4d5e6f70";
const ALIAS_ID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
function model(overrides: Partial<Model> = {}): Model {
  return {
    id: MODEL_ID, modelId: "us.anthropic.claude-opus-4-6-v1", name: "Claude Opus 4.6", description: null, provider: "bedrock",
    inputPricePerMTok: 5, outputPricePerMTok: 25, cacheReadPricePerMTok: 0.5, cacheWrite5mPricePerMTok: null, cacheWrite1hPricePerMTok: null,
    contextWindow: null, maxOutputTokens: 128000, thinking: true, reasoningMode: "auto", defaultReasoningEffort: null, managedCache: false,
    region: null, enabled: true, available: true, createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z", ...overrides,
  };
}
function alias(overrides: Partial<Alias> = {}): Alias {
  return {
    id: ALIAS_ID, modelId: "opus-max", name: "Opus max", description: null, upstreamModelId: MODEL_ID, reasoningSource: "alias",
    thinking: true, effort: "max", enabled: true, available: true, createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z", ...overrides,
  };
}
function catalogRoutes(apps: App[] = []): Record<string, Handler> {
  return {
    "GET /models": () => ({ body: { data: [model()] } }),
    "GET /model-aliases": () => ({ body: { data: [alias()] } }),
    "GET /model-apps": () => ({ body: { data: apps } }),
  };
}

describe("model catalog commands", () => {
  test("models create sends prices and clears with '' and default", async () => {
    const client = new FakeClient({ "POST /models": (request) => ({ status: 201, body: { data: model({ ...(request.json as object), enabled: false }) } }) });
    const result = await run(["models", "create", "--model-id", " amazon.nova-pro-v1:0 ", "--input-price", "0.8", "--output-price", "$3.20",
      "--cache-read-price", "0.2", "--cache-write-5m-price", "none", "--region", "", "--default-effort", "default", "--thinking", "on",
      "--reasoning-mode", "nova", "--max-output-tokens", "10000", "--disabled"], client);
    expect(result.code).toBe(0);
    expect(client.mutations()[0]!.json).toEqual({
      modelId: "amazon.nova-pro-v1:0", name: "amazon.nova-pro-v1:0", inputPricePerMTok: 0.8, outputPricePerMTok: 3.2,
      cacheReadPricePerMTok: 0.2, cacheWrite5mPricePerMTok: null, maxOutputTokens: 10000, region: null, thinking: true,
      reasoningMode: "nova", defaultReasoningEffort: null, enabled: false,
    });
  });

  test("models create requires both prices, and update requires a change", async () => {
    const client = new FakeClient(catalogRoutes());
    const missing = await run(["models", "create", "--model-id", "x", "--input-price", "1"], client);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--input-price and --output-price are required");
    const nothing = await run(["models", "update", "Claude Opus 4.6"], client);
    expect(nothing.code).toBe(2);
    const effort = await run(["models", "update", "Claude Opus 4.6", "--default-effort", "turbo"], client);
    expect(effort.code).toBe(2);
    expect(effort.err).toContain("--default-effort must be one of none, minimal, low, medium, high, xhigh, max, or default");
    expect(client.mutations()).toHaveLength(0);
  });

  test("models update resolves a model by name and patches only the given fields", async () => {
    const client = new FakeClient({ ...catalogRoutes(), [`PATCH /models/${MODEL_ID}`]: (request) => ({ body: { data: model(request.json as Partial<Model>) } }) });
    const result = await run(["models", "update", "claude opus 4.6", "--cache-read-price", "", "--context-window", "200000"], client);
    expect(result.code).toBe(0);
    expect(client.mutations()[0]!.json).toEqual({ cacheReadPricePerMTok: null, contextWindow: 200000 });
  });

  test("aliases create resolves the upstream model to its ID", async () => {
    const client = new FakeClient({ ...catalogRoutes(), "POST /model-aliases": (request) => ({ status: 201, body: { data: alias({ ...(request.json as Partial<Alias>), id: "new" }) } }) });
    const result = await run(["aliases", "create", "opus", "--upstream", "us.anthropic.claude-opus-4-6-v1", "--reasoning", "client", "--description", "Opus"], client);
    expect(result.code).toBe(0);
    expect(client.mutations()[0]!.json).toEqual({ modelId: "opus", name: "opus", description: "Opus", reasoningSource: "client", upstreamModelId: MODEL_ID });
    expect(result.out).toContain("Added alias opus for us.anthropic.claude-opus-4-6-v1 (client); API clients can use the model ID opus.");
    const pinned = await run(["aliases", "create", "opus-x", "--upstream", "Claude Opus 4.6", "--reasoning", "maybe"], client);
    expect(pinned.code).toBe(2);
    expect(pinned.err).toContain("--reasoning must be pinned");
  });

  test("apps create maps tiers to alias IDs and keeps the default tiers", async () => {
    const client = new FakeClient({ ...catalogRoutes(), "POST /model-apps": (request) => {
      const body = request.json as { name: string; tiers: { name: string; aliasId: string | null }[] };
      return { status: 201, body: { data: { id: "app", name: body.name, description: null, enabled: true, createdAt: "", updatedAt: "",
        tiers: body.tiers.map((tier) => ({ ...tier, modelId: `${body.name}-${tier.name}`, available: tier.aliasId !== null })) } } };
    } });
    const result = await run(["apps", "create", "chat-app", "--map", "max=opus-max"], client);
    expect(result.code).toBe(0);
    expect(client.mutations()[0]!.json).toEqual({ name: "chat-app", description: null, enabled: true, tiers: [
      { name: "min", aliasId: null }, { name: "low", aliasId: null }, { name: "medium", aliasId: null }, { name: "high", aliasId: null }, { name: "max", aliasId: ALIAS_ID },
    ] });
    expect(result.out).toContain("API clients can use chat-app-max.");
    const wrongTier = await run(["apps", "create", "other", "--tiers", "fast,smart", "--map", "max=opus-max"], client);
    expect(wrongTier.code).toBe(2);
    expect(wrongTier.err).toContain("'max' is not one of the app's tiers (fast, smart)");
    const extraEquals = await run(["apps", "create", "other", "--map", "max=opus-max=foo"], client);
    expect(extraEquals.code).toBe(1);
    expect(extraEquals.err).toContain("No alias 'opus-max=foo'");
    const tooExpensive = await run(["models", "update", "Claude Opus 4.6", "--input-price", "1e15"], client);
    expect(tooExpensive.code).toBe(2);
    expect(tooExpensive.err).toContain("--input-price must be at most 999,999,999,999");
  });

  test("apps set-tier remaps, adds and unmaps tiers", async () => {
    const app: App = { id: "app", name: "chat-app", description: null, enabled: true, createdAt: "", updatedAt: "", tiers: [
      { name: "low", aliasId: null, modelId: "chat-app-low", available: false }, { name: "max", aliasId: ALIAS_ID, modelId: "chat-app-max", available: true },
    ] };
    const client = new FakeClient({ ...catalogRoutes([app]), "PATCH /model-apps/app": (request) => {
      const tiers = (request.json as { tiers: { name: string; aliasId: string | null }[] }).tiers;
      return { body: { data: { ...app, tiers: tiers.map((tier) => ({ ...tier, modelId: `chat-app-${tier.name}`, available: tier.aliasId !== null })) } } };
    } });
    expect((await run(["apps", "set-tier", "chat-app", "low", "opus-max"], client)).out).toBe("chat-app-low now serves alias opus-max.\n");
    expect((await run(["apps", "set-tier", "chat-app", "fast", "Opus max"], client)).out).toBe("Added tier: chat-app-fast now serves alias opus-max.\n");
    expect((await run(["apps", "set-tier", "chat-app", "max", "-"], client)).out).toContain("chat-app-max is unmapped");
    expect(client.mutations().map((request) => request.json)).toEqual([
      { tiers: [{ name: "low", aliasId: ALIAS_ID }, { name: "max", aliasId: ALIAS_ID }] },
      { tiers: [{ name: "low", aliasId: null }, { name: "max", aliasId: ALIAS_ID }, { name: "fast", aliasId: ALIAS_ID }] },
      { tiers: [{ name: "low", aliasId: null }, { name: "max", aliasId: null }] },
    ]);
    const bad = await run(["apps", "set-tier", "chat-app", "Max Tier", "opus-max"], client);
    expect(bad.code).toBe(2);
  });

  test("ambiguous names ask for an ID", async () => {
    const client = new FakeClient({ "GET /models": () => ({ body: { data: [model(), model({ id: "other", modelId: "eu.anthropic.claude-opus-4-6-v1" })] } }) });
    const result = await run(["models", "get", "Claude Opus 4.6"], client);
    expect(result.code).toBe(1);
    expect(result.err).toContain("2 models are named 'Claude Opus 4.6'; use one of: us.anthropic.claude-opus-4-6-v1, eu.anthropic.claude-opus-4-6-v1");
    const test = await run(["aws", "test", "Claude Opus 4.6"], client);
    expect(test.code).toBe(1);
    expect(test.err).toContain("2 models are named 'Claude Opus 4.6'");
    expect(client.mutations()).toHaveLength(0);
  });

  test("aws test uses a configured model's ID and region, or a raw Bedrock ID", async () => {
    const client = new FakeClient({
      "GET /models": () => ({ body: { data: [model({ region: "eu-west-1" })] } }),
      "POST /aws/test": () => ({ body: { success: true, message: "Connection succeeded" } }),
    });
    expect((await run(["aws", "test", "claude opus 4.6"], client)).out).toBe("Connection succeeded (us.anthropic.claude-opus-4-6-v1 in eu-west-1).\n");
    expect((await run(["aws", "test", "amazon.nova-micro-v1:0"], client)).out).toBe("Connection succeeded (amazon.nova-micro-v1:0).\n");
    expect(client.mutations().map((request) => request.json)).toEqual([
      { modelId: "us.anthropic.claude-opus-4-6-v1", region: "eu-west-1" }, { modelId: "amazon.nova-micro-v1:0" },
    ]);
    const noRead = new FakeClient({ "GET /models": () => ({ status: 403, body: { error: { code: "insufficient_scope", message: "Required scope: models.read" } } }) });
    const result = await run(["aws", "test"], noRead);
    expect(result.code).toBe(2);
    expect(result.err).toContain("finding a configured model needs a key with models.read");
  });
});

describe("analytics commands", () => {
  const throughput = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z", summary: { requests: 3, tokens: 30, activeHours: 2.5, steadyStateTpm: 0.2, steadyStateRpm: 0.02, peakTpm: 20, peakTpmAt: null, peakRpm: 2, peakRpmAt: null, avgInputTokensPerRequest: 8, avgOutputTokensPerRequest: 2, avgCacheReadTokensPerRequest: 0 }, models: [] };
  const routes = (): Record<string, Handler> => ({
    ...userRoutes(),
    ...userRoutes(user({ id: "u-alice", username: "alice", email: "alice@example.com" })),
    "GET /users": (request) => page([user(), user({ id: "u-alice", username: "alice", email: "alice@example.com" })].filter((candidate) => candidate.username === request.query.search)),
    "GET /groups": () => page([{ id: "g-eng", name: "engineering" }, { id: "g-ops", name: "Sales, EMEA" }]),
    "GET /analytics/throughput": () => ({ body: { data: throughput } }),
    "GET /analytics/users": () => ({ body: { data: { users: [] } } }),
    "GET /analytics/groups": () => ({ body: { data: { groups: [] } } }),
  });

  test("select several users and groups, and keep names with commas whole", async () => {
    const client = new FakeClient(routes());
    const result = await run(["analytics", "throughput", "--user", "bob", "--user", "alice", "--user", "bob", "--group", "engineering", "--group", "Sales, EMEA"], client);
    expect(result.code).toBe(0);
    const request = client.requests.at(-1)!;
    expect(request.path).toBe("/analytics/throughput");
    expect(request.search.getAll("userId")).toEqual(["u-bob", "u-alice"]);
    expect(request.search.getAll("groupId")).toEqual(["g-eng", "g-ops"]);
    expect(request.search.get("timeRange")).toBe("month");
    expect(result.out).toStartWith("Last 30 days (2026-10-01T00:00:00Z to 2026-11-01T00:00:00Z), users bob, alice and groups engineering, Sales, EMEA (current members)\n");
    expect(result.out).toContain("2.50");
  });

  test("send a custom window from --from and --to, or until now", async () => {
    const client = new FakeClient(routes());
    const custom = await run(["analytics", "users", "--from", "2026-10-01", "--to", "2026-10-15T12:00:00+02:00"], client);
    expect(custom.code).toBe(0);
    expect(Object.fromEntries(client.requests.at(-1)!.search)).toEqual({ start: "2026-10-01T00:00:00.000Z", end: "2026-10-15T10:00:00.000Z" });
    expect(custom.err).toBe("No usage from 2026-10-01T00:00:00Z to 2026-10-15T10:00:00Z.\n");
    const open = await run(["analytics", "groups", "--from", "2026-10-01T00:00:00Z", "--user", "bob"], client);
    expect(open.code).toBe(0);
    const query = client.requests.at(-1)!.search;
    expect(query.get("start")).toBe("2026-10-01T00:00:00.000Z");
    expect(Date.now() - Date.parse(query.get("end")!)).toBeLessThan(60_000);
    expect(query.getAll("userId")).toEqual(["u-bob"]);
    expect(query.has("timeRange")).toBe(false);
  });

  test.each([
    [["--range", "week", "--from", "2026-10-01"], "Choose either --range or --from and --to"],
    [["--to", "2026-10-01"], "--to needs --from"],
    [["--from", "2026-10-01T09:30"], "--from must be an ISO 8601 date"],
    [["--from", "2026-10-02", "--to", "2026-10-01"], "start must be before end"],
  ])("refuses %j before sending anything", async (options, message) => {
    const client = new FakeClient(routes());
    const result = await run(["analytics", "throughput", ...options], client);
    expect(result.code).toBe(2);
    expect(result.err).toContain(message);
    expect(client.requests.filter((request) => request.path.startsWith("/analytics"))).toHaveLength(0);
  });
});

describe("clients", () => {
  test("builds management API URLs from relative paths", () => {
    expect(managementRequest("https://gw.example.com/", "GET", "users", { query: { search: "a b", limit: 10, offset: undefined } }).url)
      .toBe("https://gw.example.com/management/v1/users?search=a+b&limit=10");
    expect(managementRequest("https://gw.example.com", "GET", "/management/v1/users/x").url).toBe("https://gw.example.com/management/v1/users/x");
  });

  test("sends the management key and never follows redirects", async () => {
    let seen: Request | undefined;
    let init: RequestInit | undefined;
    const fetcher = (async (request: Request, requestInit?: RequestInit) => {
      seen = request; init = requestInit;
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
    }) as unknown as typeof fetch;
    const client = new RemoteClient("https://gw.example.com", "aigm_secret", fetcher);
    await expect(client.send("GET", "/users")).rejects.toThrow("redirected the request to https://elsewhere.example.com/");
    expect(seen!.headers.get("authorization")).toBe("Bearer aigm_secret");
    expect(init?.redirect).toBe("manual");
  });

  test("audits local changes as the pod's aigctl", () => {
    const principal = localPrincipal("ai-gateway-7c9f-abcde");
    expect(principal).toMatchObject({ actorType: "cli", actorId: "aigctl@ai-gateway-7c9f-abcde", userId: null });
    expect(principal.scopes.has("*")).toBe(true);
    expect(localPrincipal("pod-1", parseActor(" richard ")).actorId).toBe("richard via aigctl@pod-1");
    expect(() => parseActor("evil\u001b[2J")).toThrow("without control characters");
    expect(parseActor("  ")).toBeUndefined();
  });

  test("rejects credentials in --server and warns about plain HTTP", async () => {
    expect(() => parseServerUrl("https://user:secret@gw.example.com")).toThrow("must not contain credentials");
    expect(parseServerUrl("https://gw.example.com/?x=1#y")).toBe("https://gw.example.com");
    const io = fakeIo();
    const env = { AI_GATEWAY_MANAGEMENT_KEY: "aigm_test" };
    await createClient({ ...io.io, env }, { server: "http://gateway.internal:3000" });
    expect(io.err()).toContain("plain HTTP");
    const loopback = fakeIo();
    await createClient({ ...loopback.io, env }, { server: "http://127.0.0.1:3000" });
    expect(loopback.err()).toBe("");
  });

  test("explains responses that are not management API JSON", async () => {
    const fetcher = (async () => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const client = new RemoteClient("https://gw.example.com", "aigm_secret", fetcher);
    await expect(call(client, "GET", "/users")).rejects.toThrow("Unexpected response from https://gw.example.com (HTTP 200, text/html)");
  });
});
