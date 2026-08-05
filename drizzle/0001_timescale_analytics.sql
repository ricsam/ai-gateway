-- Restore the battle-tested TimescaleDB ledger foundation.
-- This migration also upgrades databases created by the short-lived plain
-- PostgreSQL baseline before converting credit_events to a hypertable.
CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
ALTER TABLE "credit_events" DROP CONSTRAINT IF EXISTS "credit_events_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "credit_events" DROP CONSTRAINT IF EXISTS "credit_events_api_key_id_api_keys_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "credit_events_request_id_unique";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_request_receipts" (
  "request_id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "requested_amount" numeric(20,8) NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "credits_charged" numeric(20,8),
  "balance_after" numeric(20,8),
  "partially_charged" boolean,
  "event_id" text,
  "event_time" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "usage_request_receipts_status_check" CHECK ("status" in ('pending', 'complete')),
  CONSTRAINT "usage_request_receipts_amount_check" CHECK ("requested_amount" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_request_receipts_user_created_idx" ON "usage_request_receipts" ("user_id", "created_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'credit_events'::regclass
      AND conname = 'credit_events_pkey'
  ) THEN
    ALTER TABLE credit_events DROP CONSTRAINT credit_events_pkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'credit_events'::regclass
      AND conname = 'credit_events_id_time_pk'
  ) THEN
    ALTER TABLE credit_events
      ADD CONSTRAINT credit_events_id_time_pk PRIMARY KEY (id, time);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_events_request_time_unique" ON "credit_events" ("request_id", "time");
--> statement-breakpoint
SELECT create_hypertable('credit_events', by_range('time'), migrate_data => TRUE, if_not_exists => TRUE);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_events_user_time_idx" ON "credit_events" ("user_id", "time" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_events_model_time_idx" ON "credit_events" ("model", "time" DESC) WHERE "model" IS NOT NULL;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS credit_events_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '5 minutes', "time") AS bucket,
  user_id,
  model,
  SUM(credits_added) AS credits_added,
  SUM(credits_consumed) AS credits_consumed,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
  SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
  SUM(input_cost) AS input_cost,
  SUM(output_cost) AS output_cost,
  SUM(cache_read_cost) AS cache_read_cost,
  SUM(cache_write_5m_cost) AS cache_write_5m_cost,
  SUM(cache_write_1h_cost) AS cache_write_1h_cost
FROM credit_events
GROUP BY bucket, user_id, model
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS credit_events_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', "time") AS bucket,
  user_id,
  model,
  SUM(credits_added) AS credits_added,
  SUM(credits_consumed) AS credits_consumed,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
  SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
  SUM(input_cost) AS input_cost,
  SUM(output_cost) AS output_cost,
  SUM(cache_read_cost) AS cache_read_cost,
  SUM(cache_write_5m_cost) AS cache_write_5m_cost,
  SUM(cache_write_1h_cost) AS cache_write_1h_cost
FROM credit_events
GROUP BY bucket, user_id, model
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS credit_events_1d
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', "time") AS bucket,
  user_id,
  model,
  SUM(credits_added) AS credits_added,
  SUM(credits_consumed) AS credits_consumed,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
  SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
  SUM(input_cost) AS input_cost,
  SUM(output_cost) AS output_cost,
  SUM(cache_read_cost) AS cache_read_cost,
  SUM(cache_write_5m_cost) AS cache_write_5m_cost,
  SUM(cache_write_1h_cost) AS cache_write_1h_cost
FROM credit_events
GROUP BY bucket, user_id, model
WITH NO DATA;
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('credit_events_5m',
  start_offset => INTERVAL '30 minutes',
  end_offset => INTERVAL '1 minute',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE);
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('credit_events_1h',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE);
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('credit_events_1d',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE);
--> statement-breakpoint
ALTER TABLE credit_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id',
  timescaledb.compress_orderby = 'time DESC'
);
--> statement-breakpoint
SELECT add_compression_policy('credit_events', compress_after => INTERVAL '7 days', if_not_exists => TRUE);
