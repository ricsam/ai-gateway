import { defineHeadTags } from "@richie-router/server";
import { routeManifest } from "@/route-manifest";
import { routerSchema } from "@/shared/router-schema.ts";
import env from "@/env";

export const headTags = defineHeadTags(routeManifest, routerSchema, {
  __root__: {
    staleTime: 60_000,
    head: () => [
      { tag: "title", children: env.BRAND_NAME },
      { tag: "meta", name: "description", content: env.BRAND_TAGLINE },
    ],
  },
});
