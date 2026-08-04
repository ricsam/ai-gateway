import { defineHeadTags } from "@richie-router/server";
import { routeManifest } from "@/route-manifest";
import { routerSchema } from "@/shared/router-schema.ts";
import { getBranding, getPublicConfig } from "./config-service";

export const headTags = defineHeadTags(routeManifest, routerSchema, {
  __root__: {
    staleTime: 10_000,
    head: async () => {
      const [brand, config] = await Promise.all([getBranding(), getPublicConfig()]);
      return [
        { tag: "title", children: brand.productName },
        { tag: "meta", name: "description", content: brand.tagline },
        ...(config.brand.faviconUrl ? [{ tag: "link" as const, rel: "icon", href: config.brand.faviconUrl }] : []),
      ];
    },
  },
});
