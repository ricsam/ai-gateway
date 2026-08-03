import { defineRouterSchema } from "@richie-router/core";

export const routerSchema = defineRouterSchema({
  __root__: {
    serverHead: true,
  },
}, {
  passthrough: ["/api/$"],
});

export type RouterSchema = typeof routerSchema;
