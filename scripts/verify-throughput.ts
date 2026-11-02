import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// Verifies throughput statistics against real TimescaleDB with an independent
// reference implementation. Run independently of bun test. Never use
// DATABASE_URL for fixtures: only the fresh database created below.
const adminUrl = process.env.TIMESCALE_ADMIN_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL is required (permission to create temporary databases)");
const runId = crypto.randomUUID().replaceAll("-", "");
const database = `throughput_${runId}`;
await mkdir(".data", { recursive: true });
const scratch = await mkdtemp(".data/throughput-");
const manifest = { runId, databases: [database], paths: [scratch], created: false, cleanedUp: false };
const saveManifest = () => writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
await saveManifest();
const admin = new Pool({ connectionString: adminUrl });
let applicationPool: Pool | undefined;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Deliberately independent of METERED_USAGE_EVENT_TYPES.
const METERED = new Set(["usage", "chat", "api", "embedding"]);

type Fixture = {
  time: Date; userId: string; model: string | null; type: string;
  input?: number; output?: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number;
};
type Stats = {
  requests: number; tokens: number; activeHours: number; steadyStateTpm: number; steadyStateRpm: number;
  peakTpm: number; peakTpmAt: string | null; peakRpm: number; peakRpmAt: string | null;
  avgInputTokensPerRequest: number; avgOutputTokensPerRequest: number; avgCacheReadTokensPerRequest: number;
};
type Report = { start: string; end: string; summary: Stats; models: Array<Stats & { model: string | null }> };

function expectedStats(rows: Fixture[], start: Date): Stats {
  let input = 0, output = 0, cacheRead = 0;
  const periods = new Set<number>();
  const minutes = new Map<number, { requests: number; tokens: number }>();
  for (const row of rows) {
    const rowInput = (row.input ?? 0) + (row.cacheWrite5m ?? 0) + (row.cacheWrite1h ?? 0);
    input += rowInput; output += row.output ?? 0; cacheRead += row.cacheRead ?? 0;
    periods.add(Math.floor((row.time.getTime() - start.getTime()) / HOUR));
    const minute = Math.floor(row.time.getTime() / MINUTE) * MINUTE;
    const entry = minutes.get(minute) ?? { requests: 0, tokens: 0 };
    entry.requests++; entry.tokens += rowInput + (row.output ?? 0);
    minutes.set(minute, entry);
  }
  // The busiest minute; ties resolve to the most recent one.
  let peakRpm = 0, peakRpmAt: number | null = null, peakTpm = 0, peakTpmAt: number | null = null;
  for (const [minute, entry] of [...minutes].sort(([a], [b]) => a - b)) {
    if (entry.requests >= peakRpm) { peakRpm = entry.requests; peakRpmAt = minute; }
    if (entry.tokens >= peakTpm) { peakTpm = entry.tokens; peakTpmAt = minute; }
  }
  const requests = rows.length;
  const activeMinutes = periods.size * 60;
  return {
    requests, tokens: input + output, activeHours: periods.size,
    steadyStateTpm: activeMinutes ? (input + output) / activeMinutes : 0,
    steadyStateRpm: activeMinutes ? requests / activeMinutes : 0,
    peakTpm, peakTpmAt: peakTpm && peakTpmAt !== null ? new Date(peakTpmAt).toISOString() : null,
    peakRpm, peakRpmAt: peakRpm && peakRpmAt !== null ? new Date(peakRpmAt).toISOString() : null,
    avgInputTokensPerRequest: requests ? input / requests : 0,
    avgOutputTokensPerRequest: requests ? output / requests : 0,
    avgCacheReadTokensPerRequest: requests ? cacheRead / requests : 0,
  };
}

function expectedReport(fixtures: Fixture[], start: Date, end: Date, inScope: (row: Fixture) => boolean): Report {
  const rows = fixtures.filter((row) => METERED.has(row.type) && row.time >= start && row.time < end && inScope(row));
  const byModel = new Map<string | null, Fixture[]>();
  for (const row of rows) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
  return {
    start: start.toISOString(), end: end.toISOString(), summary: expectedStats(rows, start),
    models: [...byModel].map(([model, list]) => ({ model, ...expectedStats(list, start) })),
  };
}

const byModelKey = <T extends { model: string | null }>(rows: T[]) => [...rows].sort((a, b) => String(a.model).localeCompare(String(b.model)));
function assertReport(actual: Report, expected: Report, context: string) {
  assert.deepEqual({ ...actual, models: byModelKey(actual.models) }, { ...expected, models: byModelKey(expected.models) }, context);
  for (let index = 1; index < actual.models.length; index++) {
    const previous = actual.models[index - 1]!, current = actual.models[index]!;
    assert.ok(previous.tokens > current.tokens || (previous.tokens === current.tokens && previous.requests >= current.requests), `${context}: models are ordered by tokens, then requests`);
  }
}

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
  await pool.query(`INSERT INTO "user" (id, username, name, email, role, created_at, updated_at) VALUES
    ('admin', 'admin', 'Admin', 'admin@example.test', 'admin', now(), now()),
    ('dora', 'dora', 'Dora', 'dora@example.test', 'user', now(), now()),
    ('erin', 'erin', 'Erin', 'erin@example.test', 'user', now(), now()),
    ('frank', 'frank', 'Frank', 'frank@example.test', 'user', now(), now())`);
  await pool.query(`INSERT INTO groups (id, name, created_at, updated_at) VALUES ('team', 'Team', now(), now()), ('empty', 'Empty', now(), now());
    INSERT INTO group_members (group_id, user_id, joined_at) VALUES ('team', 'dora', now()), ('team', 'erin', now())`);

  const realNow = Date.now();
  // A past window whose one-hour periods start 30.5 s into a calendar minute,
  // so some minutes straddle two periods.
  const now0 = new Date(Math.floor(realNow / MINUTE) * MINUTE - 3 * DAY + 30_500);
  const start0 = new Date(now0.getTime() - DAY);
  const at = (base: Date, offsetMs: number) => new Date(base.getTime() + offsetMs);
  const boundary = at(start0, 5 * HOUR); // 30.5 s into calendar minute `straddled`.
  const straddled = new Date(Math.floor(boundary.getTime() / MINUTE) * MINUTE);
  const burst = new Date(Math.floor(at(start0, 10 * HOUR).getTime() / MINUTE) * MINUTE + 5 * MINUTE);
  const fixtures: Fixture[] = [
    // Window bounds: [start, end).
    { time: start0, userId: "dora", model: "model-a", type: "usage", input: 100, output: 10 },
    { time: at(start0, -1), userId: "dora", model: "model-a", type: "usage", input: 1_000_000, output: 1_000_000 },
    { time: now0, userId: "dora", model: "model-a", type: "usage", input: 1_000_000, output: 1_000_000 },
    { time: at(now0, -1), userId: "frank", model: "model-c", type: "embedding", input: 7 },
    // One calendar minute in two periods: counted once per minute, in both hours.
    { time: at(straddled, 10_000), userId: "dora", model: "model-b", type: "chat", input: 40, output: 4, cacheRead: 900 },
    { time: at(straddled, 50_000), userId: "dora", model: "model-b", type: "chat", input: 60, output: 6, cacheWrite1h: 30 },
    { time: at(start0, 7 * HOUR), userId: "erin", model: "model-b", type: "usage", input: 5, output: 5 },
    // The busiest minute across models has more requests than any model alone.
    { time: at(burst, 1_000), userId: "dora", model: "model-a", type: "usage", input: 10, output: 1, cacheRead: 5_000 },
    { time: at(burst, 20_000), userId: "erin", model: "model-a", type: "api", input: 20, output: 2, cacheWrite5m: 100 },
    { time: at(burst, 59_999), userId: "frank", model: "model-b", type: "usage", input: 30, output: 3 },
    // Per-row token sums above the PostgreSQL integer range.
    { time: at(start0, 15 * HOUR), userId: "erin", model: "model-a", type: "usage", input: 2_000_000_000, cacheWrite5m: 2_000_000_000, output: 2_000_000_000 },
    // Equal minutes: the most recent is the peak. Zero-token requests still count.
    { time: at(start0, 16 * HOUR), userId: "frank", model: "model-c", type: "usage", input: 50 },
    { time: at(start0, 17 * HOUR), userId: "frank", model: "model-c", type: "usage", input: 50 },
    { time: at(start0, 18 * HOUR), userId: "frank", model: "model-c", type: "usage" },
    { time: at(start0, 19 * HOUR), userId: "dora", model: null, type: "api", input: 3, output: 3 },
    // Balance changes are never inference, whatever their model or tokens.
    { time: at(burst, 30_000), userId: "dora", model: "model-a", type: "admin_adjustment", input: 999_999, output: 999_999 },
    { time: at(burst, 31_000), userId: "erin", model: "model-b", type: "monthly_reset", input: 999_999, output: 999_999 },
    // Usage relative to the actual current time, for every API time range.
    ...[2 * MINUTE, 2 * MINUTE + 30_000, 5 * MINUTE, 50 * MINUTE, 3 * HOUR, 2 * DAY, 10 * DAY, 40 * DAY, 100 * DAY, 300 * DAY].map((ago, index): Fixture => ({
      time: new Date(realNow - ago), userId: index % 2 ? "erin" : "frank", model: index % 3 ? "model-a" : "model-b",
      type: index % 4 ? "usage" : "chat", input: 1_000 + index, output: 100 + index, cacheRead: 10 * index, cacheWrite5m: index, cacheWrite1h: 2 * index,
    })),
  ];
  for (const row of fixtures) {
    await pool.query(`INSERT INTO credit_events (id, time, request_id, user_id, model, type, input_tokens, output_tokens,
      cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [crypto.randomUUID(), row.time, crypto.randomUUID(), row.userId, row.model, row.type, row.input ?? 0, row.output ?? 0, row.cacheRead ?? 0, row.cacheWrite5m ?? 0, row.cacheWrite1h ?? 0]);
  }
  const scopes: Array<{ name: string; scope: { userId?: string; groupId?: string }; query: string; filter: (row: Fixture) => boolean }> = [
    { name: "system", scope: {}, query: "", filter: () => true },
    { name: "user", scope: { userId: "dora" }, query: "&userId=dora", filter: (row) => row.userId === "dora" },
    { name: "group", scope: { groupId: "team" }, query: "&groupId=team", filter: (row) => row.userId === "dora" || row.userId === "erin" },
    { name: "empty group", scope: { groupId: "empty" }, query: "&groupId=empty", filter: () => false },
    { name: "unknown user", scope: { userId: "nobody" }, query: "&userId=nobody", filter: () => false },
  ];

  // 1. A fixed past window with boundary, straddle, tie and overflow cases.
  const { getThroughput } = await import("../backend/throughput-service");
  for (const { name, scope, filter } of scopes) {
    assertReport(await getThroughput("day", scope, now0), expectedReport(fixtures, start0, now0, filter), `fixed day window, ${name}`);
  }
  const fixed = await getThroughput("day", {}, now0);
  const modelB = fixed.models.find((row) => row.model === "model-b")!;
  assert.equal(modelB.peakRpm, 2, "a straddled minute is one minute");
  assert.equal(modelB.peakRpmAt, straddled.toISOString());
  assert.equal(fixed.summary.peakRpm, 3, "summary peaks combine models");
  assert.equal(fixed.summary.peakRpmAt, burst.toISOString());
  assert.equal(fixed.summary.peakTpm, 6_000_000_000, "token sums are not limited to 32-bit integers");
  const modelC = fixed.models.find((row) => row.model === "model-c")!;
  assert.equal(modelC.peakTpmAt, new Date(Math.floor(at(start0, 17 * HOUR).getTime() / MINUTE) * MINUTE).toISOString(), "ties report the most recent minute");
  assert.deepEqual({ requests: modelC.requests, activeHours: modelC.activeHours }, { requests: 4, activeHours: 4 });
  assert.equal(fixed.models.find((row) => row.model === null)?.requests, 1, "requests without a model are reported");
  const modelBReport = expectedReport(fixtures, start0, now0, () => true).models.find((row) => row.model === "model-b")!;
  assert.equal(modelBReport.activeHours, 4, "fixture sanity: straddled minute spans periods 4 and 5");

  // 2. The management API for every time range and scope, at the current time.
  const { hashApiKey } = await import("../backend/api-key-utils");
  const key = `aigm_${runId}`;
  const limitedKey = `aigm_limited_${runId}`;
  await pool.query("INSERT INTO management_api_keys (id, name, key_hash, key_prefix, scopes, created_by_user_id, created_at) VALUES ($1,$2,$3,$4,$5,'admin',now()), ($6,$7,$8,$9,$10,'admin',now())",
    ["usage", "Throughput verification", await hashApiKey(key), key.slice(0, 13), ["usage.read"], "limited", "No usage scope", await hashApiKey(limitedKey), limitedKey.slice(0, 13), ["users.read"]]);
  const { handleManagementApi } = await import("../backend/management-api");
  const call = (path: string, token = key) => handleManagementApi(new Request(`http://localhost:3000/management/v1${path}`, { headers: { authorization: `Bearer ${token}` } }));
  let checks = 0;
  for (const timeRange of ["hour", "day", "week", "month", "quarter", "year"]) {
    for (const { name, query, filter } of scopes) {
      const response = await call(`/analytics/throughput?timeRange=${timeRange}${query}`);
      assert.equal(response.status, 200, `${timeRange} ${name}: ${await response.clone().text()}`);
      const { data } = await response.json() as { data: Report };
      assertReport(data, expectedReport(fixtures, new Date(data.start), new Date(data.end), filter), `management API ${timeRange}, ${name}`);
      if (timeRange === "hour" && name === "system") assert.ok(data.summary.requests >= 4 && data.summary.activeHours === 1, "Last 60 minutes is a single period");
      checks++;
    }
  }
  const defaultRange = await (await call("/analytics/throughput")).json() as { data: Report };
  assert.equal(new Date(defaultRange.data.end).getTime() - new Date(defaultRange.data.start).getTime(), 30 * DAY, "timeRange defaults to month");
  for (const [path, status] of [
    ["/analytics/throughput?timeRange=decade", 400],
    ["/analytics/throughput?timeRange=day&userId=dora&groupId=team", 400],
  ] as const) assert.equal((await call(path)).status, status, path);
  assert.equal((await call("/analytics/throughput?timeRange=day", limitedKey)).status, 403, "usage.read is required");
  const openapi = await (await call("/openapi.json")).json() as { paths: Record<string, unknown>; components: { schemas: Record<string, unknown> } };
  assert.ok(openapi.paths["/analytics/throughput"] && openapi.components.schemas.ThroughputStats, "runtime OpenAPI documents the endpoint");
  console.log(`Throughput verification passed: fixed-window bounds, straddled minutes, cross-model peaks, ties, 64-bit sums, metered types; ${checks} management API range/scope checks, validation and scopes.`);
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
