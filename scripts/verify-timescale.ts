import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const adminUrl = process.env.TIMESCALE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!adminUrl) throw new Error("TIMESCALE_ADMIN_URL or DATABASE_URL is required");

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9_]/g, "");
const names = { fresh: `llm_proxy_fresh_${suffix}`, upgrade: `llm_proxy_upgrade_${suffix}` };
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
      analytics.getCreditsConsumed("hour", "5m", { userId: "verify-user" }),
      analytics.getBalanceBurndown("hour", "5m", { userId: "verify-user" }),
      analytics.getUsageByModel("hour", "5m", { userId: "verify-user" }, 5),
      analytics.getTokensConsumed("hour", "5m", { userId: "verify-user" }),
      analytics.getModelSummary("hour", "5m", { userId: "verify-user" }),
      analytics.getUserSummary("hour"),
      analytics.getGroupSummary("hour"),
    ]);
    if (!results[0].some((point: { consumed: number }) => point.consumed === 0.5)) throw new Error("Gap-filled credit query missed fixture usage");
    const analyticsDb = await import("../backend/db.ts");
    await analyticsDb.pool.end();
  } finally {
    await pool.end();
  }
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
