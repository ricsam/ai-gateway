import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AnalyticsQueryError } from "../shared/analytics-time-ranges";
import { analyticsScope, isEverybody, MAX_SCOPE_IDS, scopeSql, selectedGroupsSql } from "./analytics-scope";

const dialect = new PgDialect();
const render = (query: ReturnType<typeof sql>) => {
  const { sql: text, params } = dialect.sqlToQuery(query);
  return { text: text.replace(/\s+/g, " ").trim(), params };
};

describe("analytics scope", () => {
  test("keeps each selected user and group once, without blanks", () => {
    expect(analyticsScope([" u1 ", "u2", "u1", "", null, undefined], ["g1", "g1 "])).toEqual({ userIds: ["u1", "u2"], groupIds: ["g1"] });
    expect(analyticsScope()).toEqual({});
    expect(analyticsScope([""], [" "])).toEqual({});
  });

  test("limits a selection's size", () => {
    const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
    expect(analyticsScope(ids("u", MAX_SCOPE_IDS - 1), ["g"]).userIds).toHaveLength(MAX_SCOPE_IDS - 1);
    expect(() => analyticsScope(ids("u", MAX_SCOPE_IDS), ["g"])).toThrow(AnalyticsQueryError);
    expect(() => analyticsScope([], ids("g", MAX_SCOPE_IDS + 1))).toThrow(`at most ${MAX_SCOPE_IDS}`);
  });

  test("covers everybody without a selection", () => {
    expect(isEverybody(undefined)).toBe(true);
    expect(isEverybody({ userIds: [], groupIds: [] })).toBe(true);
    expect(isEverybody({ groupIds: ["g1"] })).toBe(false);
    expect(render(sql`SELECT 1 FROM credit_events WHERE true ${scopeSql(undefined)}`)).toEqual({ text: "SELECT 1 FROM credit_events WHERE true", params: [] });
    expect(render(sql`${selectedGroupsSql({ userIds: ["u1"] })}`).text).toBe("");
  });

  test("selects the union of the users and the current members of the groups", () => {
    expect(render(sql`WHERE true ${scopeSql({ userIds: ["u1", "u2"], groupIds: ["g1"] })}`)).toEqual({
      text: "WHERE true AND (user_id IN ($1, $2) OR user_id IN (SELECT user_id FROM group_members WHERE group_id IN ($3)))",
      params: ["u1", "u2", "g1"],
    });
    expect(render(sql`WHERE true ${scopeSql({ userIds: ["u1"] }, sql.raw("id"))}`)).toEqual({ text: "WHERE true AND (id IN ($1))", params: ["u1"] });
    expect(render(sql`WHERE true ${scopeSql({ groupIds: ["g1", "g2"] })}`)).toEqual({
      text: "WHERE true AND (user_id IN (SELECT user_id FROM group_members WHERE group_id IN ($1, $2)))",
      params: ["g1", "g2"],
    });
  });

  test("limits group rows to the selected groups", () => {
    expect(render(sql`WHERE true ${selectedGroupsSql({ userIds: ["u1"], groupIds: ["g1", "g2"] }, sql.raw("gm.group_id"))}`)).toEqual({
      text: "WHERE true AND gm.group_id IN ($1, $2)",
      params: ["g1", "g2"],
    });
  });
});
