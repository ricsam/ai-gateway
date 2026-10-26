import { Pool, type QueryResultRow } from "pg";
import type { ConversationBoundaryStore, StoredConversationBoundary } from "./conversation-cache-types";

interface Database {
  executeRaw<Row extends QueryResultRow = QueryResultRow>(query: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}
// Optional caching metadata must not exhaust or stall the billing/auth pool.
// This module is loaded lazily only for opt-in conversation tracking.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 500,
  statement_timeout: 500,
  lock_timeout: 250,
  query_timeout: 750,
  allowExitOnIdle: true,
});
pool.on("error", () => console.warn("Conversation cache database connection failed"));
const db: Database = { async executeRaw(query, params) {
  if (!process.env.DATABASE_URL) throw new Error("Conversation cache database is not configured");
  return pool.query(query, params);
} };

/** Atomic database CAS, shared across gateway replicas. No prompt content is stored. */
export function createConversationBoundaryStore(database: Database = db): ConversationBoundaryStore {
  let nextCleanupAt = 0;

  async function cleanup(): Promise<void> {
    const now = Date.now();
    if (now < nextCleanupAt) return;
    // Set before awaiting so concurrent requests in this replica do not fan out.
    nextCleanupAt = now + 60_000;
    try {
      await database.executeRaw(`
        DELETE FROM conversation_cache_boundaries
        WHERE key IN (
          SELECT key FROM conversation_cache_boundaries
          WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
        )
      `);
    } catch {
      // Opportunistic retention must not prevent otherwise successful reads/writes.
      // Later activity retries; do not log keys, identities, or database parameters.
    }
  }

  return {
    async get(key): Promise<StoredConversationBoundary | undefined> {
      await cleanup();
      const { rows } = await database.executeRaw<{
        version: string; message_index: number; content_index: number;
        prefix_hash: string; ttl: "5m" | "1h"; expires_at: Date;
      }>(`
        SELECT version, message_index, content_index, prefix_hash, ttl, expires_at
        FROM conversation_cache_boundaries
        WHERE key = $1 AND expires_at > clock_timestamp()
      `, [key]);
      const row = rows[0];
      return row ? {
        version: row.version,
        boundary: { messageIndex: row.message_index, contentIndex: row.content_index, prefixHash: row.prefix_hash, ttl: row.ttl },
        expiresAt: row.expires_at.getTime(),
      } : undefined;
    },

    async put({ key, userId, expectedVersion, boundary, expiresAt }): Promise<void> {
      await cleanup();
      const version = crypto.randomUUID();
      const values = [key, userId, version, boundary.messageIndex, boundary.contentIndex, boundary.prefixHash, boundary.ttl, new Date(expiresAt)];
      if (expectedVersion === null) {
        // A concurrent first writer wins. A missing read may also mean an expired
        // row: replacing that row is safe, but never overwrite a live receipt.
        await database.executeRaw(`
          INSERT INTO conversation_cache_boundaries
            (key, user_id, version, message_index, content_index, prefix_hash, ttl, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (key) DO UPDATE SET
            version = EXCLUDED.version, message_index = EXCLUDED.message_index,
            content_index = EXCLUDED.content_index, prefix_hash = EXCLUDED.prefix_hash,
            ttl = EXCLUDED.ttl, expires_at = EXCLUDED.expires_at
          WHERE conversation_cache_boundaries.expires_at <= clock_timestamp()
            AND conversation_cache_boundaries.user_id = EXCLUDED.user_id
        `, values);
      } else {
        // Do not upsert here: a receipt removed by retention must not be revived
        // by a slow response using a version that no longer exists.
        await database.executeRaw(`
          UPDATE conversation_cache_boundaries SET
            version = $3, message_index = $4, content_index = $5,
            prefix_hash = $6, ttl = $7, expires_at = $8
          WHERE key = $1 AND user_id = $2 AND version = $9
        `, [...values, expectedVersion]);
      }
    },
  };
}

export const conversationBoundaryStore = createConversationBoundaryStore();
