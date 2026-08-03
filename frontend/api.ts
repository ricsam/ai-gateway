import { createClient } from "@richie-rpc/client";
import { createTanstackQueryApi } from "@richie-rpc/react-query";
import { contract } from "@/shared/contract";
import { QueryClient } from "@tanstack/react-query";
import env from "@/env";

// REST client - uses relative path for API calls
export const client = createClient(contract, {
  baseUrl: env.BASE_URL + "/api/router",
});

// React Query hooks
export const api = createTanstackQueryApi(client, contract);

// Query client
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 1,
    },
  },
});
