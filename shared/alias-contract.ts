import { defineContract, Status } from "@richie-rpc/core";
import { z } from "zod";
import { EFFORT_LEVELS } from "./reasoning";

const slug = z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const aliasInputSchema = z.object({
  modelId: z.string().min(1).max(128).regex(/^[a-z0-9._-]+$/),
  name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable(),
  upstreamModelId: z.string().uuid(),
  reasoningSource: z.enum(["alias", "client"]).default("alias"),
  thinking: z.boolean().default(false),
  effort: z.enum(EFFORT_LEVELS).nullable().default(null), enabled: z.boolean(),
});
export const appTierInputSchema = z.object({ name: slug, aliasId: z.string().uuid().nullable() });
export const appInputSchema = z.object({
  name: slug, description: z.string().max(2000).nullable(), enabled: z.boolean(), tiers: z.array(appTierInputSchema).min(1).max(50),
});
const timestamps = { id: z.string().uuid(), createdAt: z.string(), updatedAt: z.string() };
export const aliasSchema = aliasInputSchema.extend(timestamps);
export const appSchema = appInputSchema.extend({ ...timestamps, tiers: z.array(appTierInputSchema.extend({ modelId: z.string() })) });
export type AliasInput = z.infer<typeof aliasInputSchema>;
export type AppInput = z.infer<typeof appInputSchema>;
const params = z.object({ id: z.string().uuid() });
const errorResponses = {
  [Status.BadRequest]: z.object({ error: z.string() }),
  [Status.NotFound]: z.object({ error: z.string() }),
  [Status.Conflict]: z.object({ error: z.string() }),
};
const success = z.object({ success: z.boolean() });
export const aliasContract = defineContract({
  adminListAliases: { type: "standard", method: "GET", path: "/admin/aliases", responses: { [Status.OK]: z.array(aliasSchema) } },
  adminCreateAlias: { type: "standard", method: "POST", path: "/admin/aliases", body: aliasInputSchema, responses: { [Status.Created]: aliasSchema }, errorResponses },
  adminUpdateAlias: { type: "standard", method: "PUT", path: "/admin/aliases/:id", params, body: aliasInputSchema, responses: { [Status.OK]: aliasSchema }, errorResponses },
  adminDeleteAlias: { type: "standard", method: "DELETE", path: "/admin/aliases/:id", params, responses: { [Status.OK]: success }, errorResponses },
  adminListApps: { type: "standard", method: "GET", path: "/admin/apps", responses: { [Status.OK]: z.array(appSchema) } },
  adminCreateApp: { type: "standard", method: "POST", path: "/admin/apps", body: appInputSchema, responses: { [Status.Created]: appSchema }, errorResponses },
  adminUpdateApp: { type: "standard", method: "PUT", path: "/admin/apps/:id", params, body: appInputSchema, responses: { [Status.OK]: appSchema }, errorResponses },
  adminDeleteApp: { type: "standard", method: "DELETE", path: "/admin/apps/:id", params, responses: { [Status.OK]: success }, errorResponses },
});
