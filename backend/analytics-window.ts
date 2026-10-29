export type AggregateTable = "credit_events_5m" | "credit_events_1h" | "credit_events_1d";

// Bucket widths of the continuous aggregates created in drizzle/0001_timescale_analytics.sql.
const AGGREGATE_BUCKET_MS: Record<AggregateTable, number> = {
  credit_events_5m: 5 * 60 * 1000,
  credit_events_1h: 60 * 60 * 1000,
  credit_events_1d: 24 * 60 * 60 * 1000,
};

/**
 * Start of the first whole aggregate bucket in the window [start, end).
 *
 * Rolling windows rarely start on a bucket boundary, and the aggregate bucket
 * containing `start` also holds events from before the window. Analytics read
 * [start, wholeBucketStart) from the raw ledger and the remaining buckets from
 * the aggregate. time_bucket's default origin (2000-01-03 00:00 UTC) is a whole
 * number of days after the Unix epoch, so these buckets start at multiples of
 * their width since the epoch.
 */
export function wholeBucketStart(source: AggregateTable, start: Date, end: Date): Date {
  const width = AGGREGATE_BUCKET_MS[source];
  return new Date(Math.min(Math.ceil(start.getTime() / width) * width, end.getTime()));
}
