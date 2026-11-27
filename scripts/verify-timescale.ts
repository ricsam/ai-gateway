import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const adminUrl = process.env.TIMESCALE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL or DATABASE_URL is required");

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9_]/g, "");
const names = { fresh: `ai_gateway_fresh_${suffix}`, upgrade: `ai_gateway_upgrade_${suffix}` };
const admin = new Pool({ connectionString: adminUrl });

function databaseUrl(name: string): string {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function createDatabase(name: string) {
  await admin.query(`CREATE DATABASE "${name}"`);
}

async function dropDatabase(name: string) {
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [name]);
  await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
}

async function assertFoundation(pool: Pool) {
  const hypertable = await pool.query("SELECT count(*)::int AS value FROM timescaledb_information.hypertables WHERE hypertable_name = 'credit_events'");
  if (hypertable.rows[0]?.value !== 1) throw new Error("credit_events is not a TimescaleDB hypertable");
  const aggregates = await pool.query("SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name IN ('credit_events_5m','credit_events_1h','credit_events_1d') ORDER BY view_name");
  if (aggregates.rowCount !== 3) throw new Error("Expected all three continuous aggregates");
  const jobs = await pool.query("SELECT proc_name FROM timescaledb_information.jobs WHERE proc_name IN ('policy_refresh_continuous_aggregate','policy_compression')");
  const refreshJobs = jobs.rows.filter((row) => row.proc_name === "policy_refresh_continuous_aggregate").length;
  if (refreshJobs !== 3 || !jobs.rows.some((row) => row.proc_name === "policy_compression")) throw new Error("Expected refresh and compression policies");
}

async function verifyFresh() {
  await createDatabase(names.fresh);
  const pool = new Pool({ connectionString: databaseUrl(names.fresh) });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
    await assertFoundation(pool);
    const materializedOnly = await pool.query("SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_name LIKE 'credit_events_%' AND materialized_only");
    if (materializedOnly.rowCount) throw new Error(`Continuous aggregates must use real-time aggregation: ${materializedOnly.rows.map((row) => row.view_name).join(", ")}`);
    await pool.query(`
      INSERT INTO "user" (id, username, name, email, email_verified, created_at, updated_at, credit_balance, default_monthly_credits)
      VALUES ('verify-user', 'verify', 'Verify', 'verify@example.test', true, now(), now(), 9.5, 10);
      INSERT INTO credit_events (id, time, request_id, user_id, model, source, type, credits_added, credits_consumed, input_tokens, output_tokens)
      VALUES ('verify-event', now() - interval '2 minutes', 'verify-request', 'verify-user', 'verify-model', 'api', 'usage', 10, .5, 100, 20);
    `);
    await pool.query("CALL refresh_continuous_aggregate('credit_events_5m', NULL, NULL)");
    const aggregate = await pool.query("SELECT sum(credits_consumed)::float8 AS consumed FROM credit_events_5m WHERE user_id = 'verify-user'");
    if (Number(aggregate.rows[0]?.consumed) !== 0.5) throw new Error("Continuous aggregate did not preserve usage values");

    // Execute every restored analytics query family against real sparse data.
    process.env.DATABASE_URL = databaseUrl(names.fresh);
    const analytics = await import(`../backend/analytics-service.ts?verify=${suffix}`);
    const results = await Promise.all([
      analytics.getCreditsConsumed("hour", "5m", { userIds: ["verify-user"] }),
      analytics.getBalanceBurndown("hour", "5m", { userIds: ["verify-user"] }),
      analytics.getUsageByModel("hour", "5m", { userIds: ["verify-user"] }, 5),
      analytics.getTokensConsumed("hour", "5m", { userIds: ["verify-user"] }),
      analytics.getModelSummary("hour", "5m", { userIds: ["verify-user"] }),
      analytics.getUserSummary("hour"),
      analytics.getGroupSummary("hour"),
    ]);
    if (!results[0].some((point: { consumed: number }) => point.consumed === 0.5)) throw new Error("Gap-filled credit query missed fixture usage");

    // Day buckets come from credit_events_1d, whose policy materializes whole days
    // once a day. Materialize the days before today as a running install would
    // have: today's usage stays unmaterialized, and the window's first day holds
    // usage from both before and after the start of "Last 7 days".
    await pool.query(`
      INSERT INTO credit_events (id, time, request_id, user_id, model, source, type, credits_consumed) VALUES
        ('verify-before-week', now() - interval '7 days' - interval '1 minute', 'verify-before-week', 'verify-user', 'verify-model', 'api', 'usage', .25),
        ('verify-week-start', now() - interval '7 days' + interval '1 minute', 'verify-week-start', 'verify-user', 'verify-model', 'api', 'usage', .125);
      UPDATE "user" SET credit_balance = credit_balance - .375 WHERE id = 'verify-user';
    `);
    await pool.query("CALL refresh_continuous_aggregate('credit_events_1d', NULL, time_bucket(INTERVAL '1 day', now()))");
    const scope = { userIds: ["verify-user"] };
    const [week, weekModels, weekUsers, weekBurndown, day] = await Promise.all([
      analytics.getCreditsConsumed("week", "1d", scope),
      analytics.getModelSummary("week", "1d", scope),
      analytics.getUserSummary("week"),
      analytics.getBalanceBurndown("week", "1d", scope),
      analytics.getCreditsConsumed("day", "1h", scope),
    ]);
    const consumed = (points: { consumed: number }[]) => points.reduce((total, point) => total + point.consumed, 0);
    // Today's 0.5 and the in-window 0.125 count; the 0.25 before the window does not.
    if (consumed(week) !== 0.625) throw new Error(`Week credits consumed ${consumed(week)}, expected 0.625`);
    if (weekModels.models[0]?.totalCredits !== 0.625) throw new Error("Week model summary missed unmaterialized or partial-day usage");
    if (weekUsers.users[0]?.creditsUsed !== 0.625) throw new Error("Week user summary missed unmaterialized or partial-day usage");
    if (weekBurndown.data.at(-1)?.balance !== weekBurndown.currentBalance) throw new Error("Week burndown does not end at the current balance");
    if (consumed(day) !== 0.5) throw new Error(`Day credits consumed ${consumed(day)}, expected 0.5 from the unmaterialized hour`);
    await verifyCustomWindowsAndSelections(pool, analytics);
    const analyticsDb = await import("../backend/db.ts");
    await analyticsDb.pool.end();
  } finally {
    await pool.end();
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Custom windows ending in the past, and selections of several users and
 * groups, against sums computed directly from credit_events. A whole day after
 * the window's end is materialized in credit_events_1d: reading that day's
 * aggregate bucket would count usage from after the window.
 */
async function verifyCustomWindowsAndSelections(pool: Pool, analytics: any) {
  const day0 = Math.floor((Date.now() - 20 * DAY_MS) / DAY_MS) * DAY_MS;
  const at = (days: number, hours: number) => new Date(day0 + days * DAY_MS + hours * 60 * 60 * 1000);
  await pool.query(`
    INSERT INTO "user" (id, username, name, email, email_verified, created_at, updated_at, credit_balance, default_monthly_credits) VALUES
      ('win-alice', 'win-alice', 'Alice', 'win-alice@example.test', true, now(), now(), 11, 0),
      ('win-bob', 'win-bob', 'Bob', 'win-bob@example.test', true, now(), now(), 22, 0),
      ('win-carol', 'win-carol', 'Carol', 'win-carol@example.test', true, now(), now(), 33, 0),
      ('win-dave', 'win-dave', 'Dave', 'win-dave@example.test', true, now(), now(), 44, 0);
    INSERT INTO groups (id, name, created_at, updated_at) VALUES ('win-a', 'Window A', now(), now()), ('win-b', 'Window B', now(), now());
    INSERT INTO group_members (group_id, user_id, joined_at) VALUES ('win-a', 'win-alice', now()), ('win-a', 'win-bob', now()), ('win-b', 'win-bob', now()), ('win-b', 'win-carol', now());
  `);
  const events: [string, Date, string, string, number, number][] = [
    ["win-alice", at(0, 1), "admin_adjustment", "", 10, 0],
    ["win-alice", at(0, 3), "usage", "model-x", 0, 1], // Before the window, on its first day.
    ["win-bob", at(0, 9), "usage", "model-x", 0, 0.5], // The window's partial first day.
    ["win-carol", at(2, 12), "chat", "model-y", 0, 0.25],
    ["win-bob", at(3, 1), "admin_adjustment", "", 5, 0],
    ["win-dave", at(4, 6), "api", "model-x", 0, 0.125], // The window's partial last day.
    ["win-alice", at(4, 6), "usage", "model-y", 0, 0.0625],
    ["win-carol", at(4, 18), "usage", "model-x", 0, 2], // After the window, on its last day.
    ["win-dave", at(6, 0), "usage", "model-x", 0, 4],
  ];
  for (const [userId, time, type, model, added, consumed] of events)
    await pool.query("INSERT INTO credit_events (id, time, request_id, user_id, model, source, type, credits_added, credits_consumed) VALUES ($1, $2, $1, $3, $4, 'api', $5, $6, $7)",
      [`win-${crypto.randomUUID()}`, time, userId, model || null, type, added, consumed]);
  for (const view of ["credit_events_5m", "credit_events_1h", "credit_events_1d"]) await pool.query(`CALL refresh_continuous_aggregate('${view}', NULL, NULL)`);
  const materialized = await pool.query("SELECT sum(credits_consumed)::float8 AS value FROM credit_events_1d WHERE bucket = $1 AND user_id LIKE 'win-%'", [at(4, 0)]);
  if (Number(materialized.rows[0]?.value) !== 2.1875) throw new Error("Fixture sanity: the window's last day is materialized with usage from after the window");

  const window = { start: at(0, 6), end: at(4, 12) };
  const selections: [string, { userIds?: string[]; groupIds?: string[] }, string[]][] = [
    ["one user", { userIds: ["win-bob"] }, ["win-bob"]],
    ["two users", { userIds: ["win-bob", "win-dave"] }, ["win-bob", "win-dave"]],
    ["two groups", { groupIds: ["win-a", "win-b"] }, ["win-alice", "win-bob", "win-carol"]],
    ["users and groups", { userIds: ["win-dave", "win-bob"], groupIds: ["win-a", "win-b"] }, ["win-alice", "win-bob", "win-carol", "win-dave"]],
  ];
  const reference = async (users: string[], from: Date, to: Date) => {
    const { rows } = await pool.query(`SELECT
        COALESCE(SUM(credits_consumed) FILTER (WHERE time >= $2 AND type IN ('usage', 'chat', 'api', 'embedding')), 0)::float8 AS consumed,
        COALESCE(SUM(credits_added - credits_consumed), 0)::float8 AS balance
      FROM credit_events WHERE user_id = ANY($1) AND time < $3`, [users, from, to]);
    return { consumed: Number(rows[0].consumed), balance: Number(rows[0].balance) };
  };
  const close = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-9;
  for (const [name, scope, users] of selections) {
    const expected = await reference(users, window.start, window.end);
    for (const bucket of ["1h", "1d", "30m"]) {
      const points = await analytics.getCreditsConsumed(window, bucket, scope) as { time: string; consumed: number }[];
      const total = points.reduce((sum, point) => sum + point.consumed, 0);
      if (!close(total, expected.consumed)) throw new Error(`Custom window ${bucket} credits for ${name}: ${total}, expected ${expected.consumed}`);
      const burndown = await analytics.getBalanceBurndown(window, bucket, scope);
      if (!close(burndown.data.at(-1)?.balance, expected.balance)) throw new Error(`Custom window ${bucket} burndown for ${name} ends at ${burndown.data.at(-1)?.balance}, expected the balance at its end, ${expected.balance}`);
      // Each point is the balance at the end of its bucket; the first bucket starts before the window.
      const first = await reference(users, window.start, new Date(Math.min(Date.parse(points[1]?.time ?? window.end.toISOString()), window.end.getTime())));
      if (!close(burndown.data[0]?.balance, first.balance)) throw new Error(`Custom window ${bucket} burndown for ${name} starts at ${burndown.data[0]?.balance}, expected ${first.balance}`);
    }
    const [models, people, tokens, balance] = await Promise.all([
      analytics.getModelSummary(window, undefined, scope),
      analytics.getUserSummary(window, scope),
      analytics.getTokensConsumed(window, "1d", scope),
      analytics.getBalanceBurndown(window, "1d", scope),
    ]);
    const modelTotal = models.models.reduce((sum: number, row: { totalCredits: number }) => sum + row.totalCredits, 0);
    const userTotal = people.users.reduce((sum: number, row: { creditsUsed: number }) => sum + row.creditsUsed, 0);
    if (!close(modelTotal, expected.consumed) || !close(userTotal, expected.consumed)) throw new Error(`Custom window summaries for ${name}: models ${modelTotal}, users ${userTotal}, expected ${expected.consumed}`);
    if (people.users.some((row: { userId: string }) => !users.includes(row.userId))) throw new Error(`User summary for ${name} lists users outside the selection`);
    if (tokens.data.length !== 5) throw new Error(`Custom window 1d token series has ${tokens.data.length} buckets, expected 5`);
    const balances = { "win-alice": 11, "win-bob": 22, "win-carol": 33, "win-dave": 44 } as Record<string, number>;
    const current = users.reduce((sum, user) => sum + balances[user]!, 0);
    if (balance.currentBalance !== current) throw new Error(`Current balance for ${name} is ${balance.currentBalance}, expected ${current}: each user once`);
  }
  const daily = await analytics.getCreditsConsumed(window, "1d", { groupIds: ["win-a", "win-b"] }) as { consumed: number }[];
  if (JSON.stringify(daily.map((point) => point.consumed)) !== JSON.stringify([0.5, 0, 0.25, 0, 0.0625])) throw new Error(`Custom window days: ${daily.map((point) => point.consumed)}`);
  const groups = await analytics.getGroupSummary(window, { groupIds: ["win-b"] });
  if (groups.groups.length !== 1 || groups.groups[0].groupId !== "win-b" || !close(groups.groups[0].creditsUsed, 0.75)) throw new Error(`Group summary of a selected group: ${JSON.stringify(groups.groups)}`);
  const usersGroups = await analytics.getGroupSummary(window, { userIds: ["win-alice"] });
  if (usersGroups.groups.length !== 1 || usersGroups.groups[0].groupId !== "win-a" || !close(usersGroups.groups[0].creditsUsed, 0.0625)) throw new Error(`Group summary of a selected user: ${JSON.stringify(usersGroups.groups)}`);
  // A custom window inside one hour bucket, and members without usage in the window.
  const hour = { start: at(4, 5.5), end: at(4, 6.5) };
  const inHour = await analytics.getCreditsConsumed(hour, "5m", { userIds: ["win-dave"] }) as { consumed: number }[];
  if (inHour.reduce((sum, point) => sum + point.consumed, 0) !== 0.125) throw new Error("A one-hour custom window missed usage");
  const members = await analytics.getGroupUserBurndowns(window, "1d", "win-a");
  const alice = members.users.find((user: { userId: string }) => user.userId === "win-alice");
  if (alice?.data.length !== 5 || !close(alice.data.at(-1).balance, 10 - 1 - 0.0625)) throw new Error(`Group member burndown: ${JSON.stringify(alice)}`);
}

const legacySchema = `
CREATE TABLE "user" (id text PRIMARY KEY, username text NOT NULL, credit_balance numeric(20,8) NOT NULL DEFAULT 0);
CREATE TABLE api_keys (id text PRIMARY KEY);
CREATE TABLE credit_events (
  id text PRIMARY KEY,
  time timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL,
  user_id text NOT NULL,
  api_key_id text,
  model text,
  source text NOT NULL DEFAULT 'api',
  type text NOT NULL,
  description text,
  credits_added numeric(20,8) NOT NULL DEFAULT 0,
  credits_consumed numeric(20,8) NOT NULL DEFAULT 0,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cache_read_tokens integer NOT NULL DEFAULT 0,
  cache_write_5m_tokens integer NOT NULL DEFAULT 0,
  cache_write_1h_tokens integer NOT NULL DEFAULT 0,
  input_cost numeric(20,8) NOT NULL DEFAULT 0,
  output_cost numeric(20,8) NOT NULL DEFAULT 0,
  cache_read_cost numeric(20,8) NOT NULL DEFAULT 0,
  cache_write_5m_cost numeric(20,8) NOT NULL DEFAULT 0,
  cache_write_1h_cost numeric(20,8) NOT NULL DEFAULT 0,
  CONSTRAINT credit_events_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT,
  CONSTRAINT credit_events_api_key_id_api_keys_id_fk FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX credit_events_request_id_unique ON credit_events(request_id);
INSERT INTO "user" (id, username, credit_balance) VALUES ('legacy-user', 'legacy', 9.25);
INSERT INTO credit_events (id, time, request_id, user_id, model, source, type, credits_added, credits_consumed, input_tokens, output_tokens)
VALUES ('legacy-event', now() - interval '1 day', 'legacy-request', 'legacy-user', 'legacy-model', 'api', 'api', 10, .75, 80, 16);
`;

async function verifyUpgrade() {
  await createDatabase(names.upgrade);
  const pool = new Pool({ connectionString: databaseUrl(names.upgrade) });
  try {
    await pool.query(legacySchema);
    const migration = await Bun.file("drizzle/0001_timescale_analytics.sql").text();
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) await pool.query(statement);
    await assertFoundation(pool);
    const preserved = await pool.query("SELECT credits_consumed::float8 AS consumed FROM credit_events WHERE id = 'legacy-event'");
    if (preserved.rowCount !== 1 || Number(preserved.rows[0]?.consumed) !== 0.75) throw new Error("Legacy ledger row was not preserved");
    const foreignKeys = await pool.query("SELECT count(*)::int AS value FROM pg_constraint WHERE conrelid = 'credit_events'::regclass AND contype = 'f'");
    if (foreignKeys.rows[0]?.value !== 0) throw new Error("Timescale-incompatible historical foreign keys remain");
  } finally {
    await pool.end();
  }
}

try {
  await verifyFresh();
  await verifyUpgrade();
  console.log("TimescaleDB fresh and legacy-upgrade verification passed");
} finally {
  await dropDatabase(names.fresh).catch(() => undefined);
  await dropDatabase(names.upgrade).catch(() => undefined);
  await admin.end();
}
