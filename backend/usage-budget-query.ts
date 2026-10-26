import { sql } from "drizzle-orm";
import { creditEventsTable, userTable } from "./schema";
import { METERED_USAGE_EVENT_TYPES } from "./usage-contract";

/** One statement = one PostgreSQL MVCC snapshot, including the account row.
 * Reconstruct opening funds from the ledger, never from spend + balance.
 * Keep reconciliation in NUMERIC, before converting API values to JS numbers.
 */
export function nativeMonthlyUsageQuery(userId: string) {
  const metered = sql.join(METERED_USAGE_EVENT_TYPES.map((type) => sql`${type}`), sql`, `);
  return sql`
    WITH observation AS (
      SELECT statement_timestamp() AS observed_at,
        date_trunc('month', statement_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS period_start
    ), period AS (
      SELECT *, (period_start AT TIME ZONE 'UTC' + INTERVAL '1 month') AT TIME ZONE 'UTC' AS period_end
      FROM observation
    ), ledger AS (
      SELECT e.*, e.time >= p.period_start AND e.time < p.period_end AS in_period,
        e.type IN (${metered}) AS metered
      FROM ${creditEventsTable} e CROSS JOIN period p WHERE e.user_id = ${userId}
    ), totals AS (
      SELECT
        COALESCE(SUM(credits_added - credits_consumed), 0) AS ledger_balance,
        COALESCE(SUM(credits_added - credits_consumed) FILTER (WHERE time < p.period_start), 0) AS opening_balance,
        COALESCE(SUM(credits_added) FILTER (WHERE in_period AND type = 'admin_adjustment'), 0) AS top_ups,
        COALESCE(SUM(credits_consumed) FILTER (WHERE in_period AND type = 'admin_adjustment'), 0) AS adjustment_removals,
        COALESCE(SUM(credits_added) FILTER (WHERE in_period AND type = 'monthly_reset'), 0) AS reset_additions,
        COALESCE(SUM(credits_consumed) FILTER (WHERE in_period AND type = 'monthly_reset'), 0) AS reset_removals,
        COALESCE(SUM(credits_consumed) FILTER (WHERE in_period AND metered), 0) AS spend,
        COALESCE(SUM(input_tokens) FILTER (WHERE in_period AND metered), 0) AS input_tokens,
        COALESCE(SUM(output_tokens) FILTER (WHERE in_period AND metered), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens) FILTER (WHERE in_period AND metered), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_write_5m_tokens) FILTER (WHERE in_period AND metered), 0) AS cache_write_5m_tokens,
        COALESCE(SUM(cache_write_1h_tokens) FILTER (WHERE in_period AND metered), 0) AS cache_write_1h_tokens,
        COUNT(*) FILTER (WHERE in_period AND metered) AS requests,
        COUNT(*) FILTER (WHERE NOT (metered OR type IN ('admin_adjustment', 'monthly_reset'))
          OR credits_added::text IN ('NaN', 'Infinity', '-Infinity')
          OR credits_consumed::text IN ('NaN', 'Infinity', '-Infinity')
          OR credits_added < 0 OR credits_consumed < 0
          OR (metered AND credits_added <> 0)
          OR (credits_added > 0 AND credits_consumed > 0)) AS invalid_events,
        COUNT(*) FILTER (WHERE time > p.observed_at) AS future_events
      FROM ledger CROSS JOIN period p
    ), funding AS (
      SELECT *, top_ups - adjustment_removals + reset_additions - reset_removals AS net_funding
      FROM totals
    )
    SELECT p.observed_at, p.period_start, p.period_end,
      u.credit_balance AS balance, u.default_monthly_credits AS monthly_allocation,
      f.*, opening_balance + net_funding AS effective_budget,
      CASE
        WHEN invalid_events > 0 THEN 'unsupported_ledger_event'
        WHEN future_events > 0 THEN 'future_ledger_event'
        WHEN u.credit_balance::text IN ('NaN', 'Infinity', '-Infinity')
          OR ledger_balance <> u.credit_balance OR opening_balance < 0
          OR opening_balance + net_funding - spend <> u.credit_balance
          THEN 'ledger_balance_mismatch'
        ELSE NULL
      END AS unavailable_reason
    FROM ${userTable} u CROSS JOIN period p CROSS JOIN funding f
    WHERE u.id = ${userId}
  `;
}
