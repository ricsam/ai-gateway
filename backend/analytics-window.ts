export type AggregateTable = "credit_events_5m" | "credit_events_1h" | "credit_events_1d";

// Bucket widths of the continuous aggregates created in drizzle/0001_timescale_analytics.sql.
const AGGREGATE_BUCKET_MS: Record<AggregateTable, number> = {
  credit_events_5m: 5 * 60 * 1000,
  credit_events_1h: 60 * 60 * 1000,
  credit_events_1d: 24 * 60 * 60 * 1000,
};

/**
 * Start of the aggregate bucket that contains `time`. time_bucket's default
 * origin (2000-01-03 00:00 UTC) is a whole number of days after the Unix epoch,
 * so these buckets start at multiples of their width since the epoch.
 */
export function bucketFloor(source: AggregateTable, time: Date): Date {
  const width = AGGREGATE_BUCKET_MS[source];
  return new Date(Math.floor(time.getTime() / width) * width);
}

/**
 * Start of the first whole aggregate bucket in the window [start, end).
 *
 * Windows rarely start on a bucket boundary, and the aggregate bucket
 * containing `start` also holds events from before the window. Analytics read
 * [start, wholeBucketStart) from the raw ledger and the whole buckets from the
 * aggregate.
 */
export function wholeBucketStart(source: AggregateTable, start: Date, end: Date): Date {
  const width = AGGREGATE_BUCKET_MS[source];
  return new Date(Math.min(Math.ceil(start.getTime() / width) * width, end.getTime()));
}

/**
 * End of the last whole aggregate bucket in the window [start, end).
 *
 * The aggregate bucket containing `end` also holds events from after the
 * window when the window ends in the past, as a custom window does. Analytics
 * read [wholeBucketEnd, end) from the raw ledger. A rolling window ends now, so
 * reading that bucket from the raw ledger instead of the real-time aggregate
 * gives the same values.
 */
export function wholeBucketEnd(source: AggregateTable, start: Date, end: Date): Date {
  const aligned = bucketFloor(source, end).getTime();
  return new Date(Math.max(aligned, wholeBucketStart(source, start, end).getTime()));
}
