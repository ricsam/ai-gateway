import { defineContract, Status } from "@richie-rpc/core";
import { z } from "zod";
import { EFFORT_LEVELS } from "./reasoning";

/** App and tier names: lowercase kebab-case. */
export const APP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Alias public model IDs. */
export const ALIAS_ID_PATTERN = /^[a-z0-9._-]+$/;
const slug = z.string().min(1).max(128).regex(APP_NAME_PATTERN, "must be lowercase kebab-case, such as chat-app");
const aliasFields = {
  modelId: z.string().min(1).max(128).regex(ALIAS_ID_PATTERN, "must contain only lowercase letters, digits, dots, underscores and hyphens"),
  name: z.string().trim().min(1).max(200), description: z.string().max(2000).nullable(),
  upstreamModelId: z.string().uuid(),
  reasoningSource: z.enum(["alias", "client"]),
  thinking: z.boolean(),
  effort: z.enum(EFFORT_LEVELS).nullable(), enabled: z.boolean(),
};
/** A complete alias, as the admin UI saves it. */
export const aliasInputSchema = z.object({
  ...aliasFields,
  reasoningSource: aliasFields.reasoningSource.default("alias"),
  thinking: aliasFields.thinking.default(false),
  effort: aliasFields.effort.default(null),
});
/** Management API creation: description and enabled may be left out. */
export const aliasCreateSchema = aliasInputSchema.extend({
  description: aliasFields.description.default(null),
  enabled: aliasFields.enabled.default(true),
});
/** Management API updates: the fields to change. */
export const aliasPatchSchema = z.object(aliasFields).partial();
export const appTierInputSchema = z.object({ name: slug, aliasId: z.string().uuid().nullable() });
const tiersSchema = z.array(appTierInputSchema).min(1).max(50)
  .refine((tiers) => new Set(tiers.map((tier) => tier.name)).size === tiers.length, "tier names must be unique");
const appFields = {
  name: slug, description: z.string().max(2000).nullable(), enabled: z.boolean(), tiers: tiersSchema,
};
/** A complete app, as the admin UI saves it. */
export const appInputSchema = z.object(appFields);
/** Tiers a new app starts with, as in the admin UI. */
export const DEFAULT_APP_TIERS = ["min", "low", "medium", "high", "max"] as const;
/** Management API creation: description, enabled and tiers may be left out (tiers default to unmapped DEFAULT_APP_TIERS). */
export const appCreateSchema = appInputSchema.extend({
  description: appFields.description.default(null),
  enabled: appFields.enabled.default(true),
  tiers: appFields.tiers.default(() => DEFAULT_APP_TIERS.map((name) => ({ name, aliasId: null }))),
});
/** Management API updates: the fields to change; tiers replace the whole list. */
export const appPatchSchema = z.object(appFields).partial();
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
