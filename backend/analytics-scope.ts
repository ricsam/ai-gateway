import { sql, type SQL } from "drizzle-orm";
import { AnalyticsQueryError } from "../shared/analytics-time-ranges";

/**
 * The people analytics cover: the selected users together with the current
 * members of the selected groups, each user once. Without IDs: all users.
 */
export interface AnalyticsScope {
  userIds?: readonly string[];
  groupIds?: readonly string[];
}

/** Users and groups one request may select together; groups cover larger sets. */
export const MAX_SCOPE_IDS = 100;

function distinct(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].map((value) => value?.trim() ?? "").filter(Boolean))];
}

export function analyticsScope(
  userIds: Iterable<string | null | undefined> = [],
  groupIds: Iterable<string | null | undefined> = [],
): AnalyticsScope {
  const users = distinct(userIds);
  const groups = distinct(groupIds);
  if (users.length + groups.length > MAX_SCOPE_IDS)
    throw new AnalyticsQueryError(`Select at most ${MAX_SCOPE_IDS} users and groups together`);
  return { ...(users.length ? { userIds: users } : {}), ...(groups.length ? { groupIds: groups } : {}) };
}

export function isEverybody(scope: AnalyticsScope | undefined): boolean {
  return !scope?.userIds?.length && !scope?.groupIds?.length;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * `AND (...)` that keeps rows of the scope's users, or nothing for all users.
 * `column` holds the user ID: user_id in the ledger, id in "user".
 */
export function scopeSql(scope: AnalyticsScope | undefined, column: SQL = sql.raw("user_id")): SQL {
  const users = scope?.userIds ?? [];
  const groups = scope?.groupIds ?? [];
  const clauses: SQL[] = [];
  if (users.length) clauses.push(sql`${column} IN (${idList(users)})`);
  if (groups.length)
    clauses.push(sql`${column} IN (SELECT user_id FROM group_members WHERE group_id IN (${idList(groups)}))`);
  return clauses.length ? sql`AND (${sql.join(clauses, sql` OR `)})` : sql``;
}

/** `AND group_id IN (...)` for the scope's groups, or nothing without selected groups. */
export function selectedGroupsSql(scope: AnalyticsScope | undefined, column: SQL = sql.raw("group_id")): SQL {
  const groups = scope?.groupIds ?? [];
  return groups.length ? sql`AND ${column} IN (${idList(groups)})` : sql``;
}
