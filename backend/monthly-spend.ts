import { inArray, sql, type SQLWrapper } from "drizzle-orm";
import { creditEventsTable, userTable } from "./schema";
import { currentUtcMonthRange, METERED_USAGE_EVENT_TYPES } from "./usage-contract";

/**
 * The metered usage charged to a user in the UTC calendar month containing `at`:
 * what the monthly spend limit counts, as `credits.used` in /v1/usage does.
 * `userId` may be a column, such as the user table's ID in a correlated subquery.
 */
export function monthlySpendQuery(userId: string | SQLWrapper, at: Date) {
  const { start, endExclusive } = currentUtcMonthRange(at);
  return sql`(SELECT COALESCE(SUM(${creditEventsTable.creditsConsumed}), 0) FROM ${creditEventsTable}
    WHERE ${creditEventsTable.userId} = ${userId} AND ${creditEventsTable.time} >= ${start} AND ${creditEventsTable.time} < ${endExclusive}
      AND ${inArray(creditEventsTable.type, [...METERED_USAGE_EVENT_TYPES])})`;
}

/**
 * For a user row: the monthly spend limit less this month's metered spend, never
 * below zero; null for a user without a limit, whose spend is then not summed.
 */
export function monthlySpendRemainingQuery(at = new Date()) {
  return sql<string | null>`CASE WHEN ${userTable.monthlySpendLimit} IS NULL THEN NULL
    ELSE GREATEST(${userTable.monthlySpendLimit} - ${monthlySpendQuery(userTable.id, at)}, 0) END`;
}

/** For a user row: this month's metered spend when the user has a monthly spend limit, else null. */
export function limitedMonthlySpendQuery(at = new Date()) {
  return sql<string | null>`CASE WHEN ${userTable.monthlySpendLimit} IS NULL THEN NULL ELSE ${monthlySpendQuery(userTable.id, at)} END`;
}

export function numberOrNull(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}
