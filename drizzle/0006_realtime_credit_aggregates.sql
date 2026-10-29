-- TimescaleDB 2.13 and later create continuous aggregates as materialized-only,
-- so analytics showed a bucket only after a refresh policy had materialized it.
-- credit_events_1d is refreshed once a day and only for whole days: the current
-- day never appeared in day-bucketed charts, and the previous day appeared only
-- after the next daily run. Real-time aggregation answers buckets the policies
-- have not yet materialized from credit_events at query time. The refresh
-- policies are unchanged and still materialize older buckets.
ALTER MATERIALIZED VIEW credit_events_5m SET (timescaledb.materialized_only = false);
--> statement-breakpoint
ALTER MATERIALIZED VIEW credit_events_1h SET (timescaledb.materialized_only = false);
--> statement-breakpoint
ALTER MATERIALIZED VIEW credit_events_1d SET (timescaledb.materialized_only = false);
