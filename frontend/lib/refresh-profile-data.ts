import type { QueryClient } from "@tanstack/react-query";

export function refreshProfileData(queryClient: QueryClient) {
  return queryClient.invalidateQueries({
    // The credits card comes from the profile, not the analytics queries.
    predicate: (query) =>
      query.queryKey[0] === "getProfile" ||
      String(query.queryKey[0]).includes("analytics") ||
      query.queryKey[0] === "usage",
  });
}
