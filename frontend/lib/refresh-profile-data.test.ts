import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { refreshProfileData } from "./refresh-profile-data";

describe("profile data refresh", () => {
  test("refetches fresh profile credits together with analytics and usage", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const queryKeys = [
      ["getProfile"],
      ["analytics-burndown", { timeRange: "month", bucketSize: "1d" }],
      ["analytics-consumed"],
      ["analytics-model"],
      ["analytics-model-summary"],
      ["analytics-tokens"],
      ["usage", 25],
    ];
    const previous = { creditBalance: 56.08, defaultMonthlyCredits: 150 };
    const updated = { creditBalance: 54.12, defaultMonthlyCredits: 175 };
    const fetched: unknown[][] = [];
    const unsubscribes = queryKeys.map((queryKey) => {
      client.setQueryData(queryKey, previous);
      return new QueryObserver(client, {
        queryKey,
        queryFn: async () => { fetched.push(queryKey); return updated; },
      }).subscribe(() => {});
    });

    try {
      expect(fetched).toEqual([]);
      await refreshProfileData(client);
      expect(fetched).toHaveLength(queryKeys.length);
      for (const queryKey of queryKeys) {
        expect(client.getQueryData<typeof updated>(queryKey)).toEqual(updated);
      }
    } finally {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      client.clear();
    }
  });

  test("invalidates cached usage pages without invalidating unrelated data", async () => {
    const client = new QueryClient();
    const affectedKeys = [["getProfile"], ["analytics-burndown", { timeRange: "day" }], ["usage", 0], ["usage", 25]];
    const unrelatedKeys = [["listApiKeys"], ["getModels"]];
    try {
      for (const key of [...affectedKeys, ...unrelatedKeys]) client.setQueryData(key, {});
      await refreshProfileData(client);
      for (const key of affectedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
      for (const key of unrelatedKeys) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    } finally {
      client.clear();
    }
  });
});
