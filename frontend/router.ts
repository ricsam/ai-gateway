import { routeTree } from "@/route-tree";
import { createRouter, createBrowserHistory } from "@richie-router/react";

export const history = createBrowserHistory();
const baseUrl = new URL(document.baseURI);

export const router = createRouter({
  routeTree,
  basePath: baseUrl.pathname,
  history,
});

declare module "@richie-router/react" {
  interface Register {
    router: typeof router;
  }
}
