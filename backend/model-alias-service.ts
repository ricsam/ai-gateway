import { asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import db from "./db";
import { auditEventsTable, modelAliasesTable, modelAppsTable, modelsTable } from "./schema";
import { validateAliasSettings } from "../shared/alias-options";
import {
  aliasCreateSchema, aliasInputSchema, aliasPatchSchema, appCreateSchema, appInputSchema, appPatchSchema,
  type AliasInput, type AppInput,
} from "../shared/alias-contract";
import { modelCreateSchema, modelUpdateSchema, type ModelUpdateInput } from "../shared/model-contract";
import { isReasoningEffort, isReasoningMode } from "../shared/reasoning";
import { resolveModelCatalog } from "./model-routing";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ModelRow = typeof modelsTable.$inferSelect;
type AliasRow = typeof modelAliasesTable.$inferSelect;
type AppRow = typeof modelAppsTable.$inferSelect;
type Catalog = { models: ModelRow[]; aliases: AliasRow[]; apps: AppRow[] };

/** Who changes the catalog, for the audit log: an administrator session, a management key or aigctl. */
export interface CatalogActor { actorType: string; actorId: string | null }

export class CatalogError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export function catalogErrorResponse(error: unknown) {
  if (!(error instanceof CatalogError)) throw error;
  return { status: error.status, body: { error: error.message } };
}
/** Validates a catalog write; failures are 400 CatalogErrors that name the fields. */
export function parseCatalogInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.slice(0, 5).map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  throw new CatalogError(400, details.join("; "));
}
// Every writer to the public model namespace must acquire this transaction lock.
export async function lockModelCatalog(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(1734437236, 1)`);
}
async function readCatalog(tx: Tx | typeof db): Promise<Catalog> {
  const models = await tx.select().from(modelsTable).orderBy(asc(modelsTable.name));
  const aliases = await tx.select().from(modelAliasesTable).orderBy(asc(modelAliasesTable.name));
  const apps = await tx.select().from(modelAppsTable).orderBy(asc(modelAppsTable.name));
  return { models, aliases, apps };
}
export async function loadModelCatalog(): Promise<Catalog> {
  return db.transaction(async (tx) => readCatalog(tx), { isolationLevel: "repeatable read", accessMode: "read only" });
}
export function assertPublicNamespace(catalog: Catalog) {
  const ids = new Set<string>();
  const add = (id: string) => {
    if (ids.has(id)) throw new CatalogError(409, `Public model ID '${id}' is already in use`);
    ids.add(id);
  };
  for (const model of catalog.models) add(model.modelId);
  for (const alias of catalog.aliases) add(alias.modelId);
  const names = new Set<string>();
  for (const app of catalog.apps) {
    if (names.has(app.name)) throw new CatalogError(409, `App '${app.name}' already exists`);
    names.add(app.name);
    for (const tier of app.tiers) add(`${app.name}-${tier.name}`);
  }
}
export async function assertModelPublicId(tx: Tx, modelId: string, exceptId?: string) {
  const catalog = await readCatalog(tx);
  const occupied = catalog.models.some((row) => row.id !== exceptId && row.modelId === modelId)
    || catalog.aliases.some((row) => row.modelId === modelId)
    || catalog.apps.some((app) => app.tiers.some((tier) => `${app.name}-${tier.name}` === modelId));
  if (occupied) throw new CatalogError(409, `Public model ID '${modelId}' is already in use`);
}
export async function validateModelWrite(tx: Tx, model: ModelRow) {
  const catalog = await readCatalog(tx);
  catalog.models = [...catalog.models.filter((row) => row.id !== model.id), model];
  assertPublicNamespace(catalog);
  for (const alias of catalog.aliases.filter((row) => row.upstreamModelId === model.id)) {
    const reason = validateAliasSettings(model, alias);
    if (reason) throw new CatalogError(409, `Alias '${alias.modelId}' would become invalid: ${reason}`);
  }
}
export async function assertModelUnreferenced(tx: Tx, id: string) {
  const [alias] = await tx.select().from(modelAliasesTable).where(eq(modelAliasesTable.upstreamModelId, id)).limit(1);
  if (alias) throw new CatalogError(409, `Model is referenced by alias '${alias.modelId}'; remove or reassign it first`);
}
export function modelResponse(model: ModelRow) {
  return {
    id: model.id,
    modelId: model.modelId,
    name: model.name,
    description: model.description,
    provider: model.provider,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok,
    cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok,
    cacheReadPricePerMTok: model.cacheReadPricePerMTok,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    thinking: model.thinking,
    reasoningMode: isReasoningMode(model.reasoningMode) ? model.reasoningMode : "auto" as const,
    defaultReasoningEffort: isReasoningEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : null,
    managedCache: model.managedCache,
    region: model.region,
    enabled: model.enabled,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}
export function aliasResponse(row: AliasRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export function appResponse(row: AppRow) {
  return { ...row, tiers: row.tiers.map((tier) => ({ ...tier, modelId: `${row.name}-${tier.name}` })), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * The catalog as the management API shows it. `available` says whether API
 * clients can use an entry, that is whether /v1/models lists it: it and what it
 * depends on are enabled, an alias's reasoning settings are valid for its
 * upstream model, and an app tier is mapped.
 */
export async function loadCatalogView() {
  const catalog = await loadModelCatalog();
  const available = new Set(resolveModelCatalog(catalog).map((entry) => entry.modelId));
  return {
    models: catalog.models.map((model) => ({ ...modelResponse(model), available: available.has(model.modelId) })),
    aliases: catalog.aliases.map((alias) => ({ ...aliasResponse(alias), available: available.has(alias.modelId) })),
    apps: catalog.apps.map((app) => {
      const response = appResponse(app);
      return { ...response, tiers: response.tiers.map((tier) => ({ ...tier, available: available.has(tier.modelId) })) };
    }),
  };
}

async function audit(tx: Tx, actor: CatalogActor, requestId: string, kind: string, action: string, id: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEventsTable).values({ actorType: actor.actorType, actorId: actor.actorId, requestId, action: `${kind}.${action}`, targetType: kind, targetId: id, metadata });
}

/** Stored text fields: surrounding spaces removed, empty means none (null). */
function modelValues(input: ModelUpdateInput) {
  const values: ModelUpdateInput = { ...input };
  if ("region" in input) values.region = input.region?.trim() || null;
  if ("description" in input) values.description = input.description?.trim() || null;
  return values;
}
export async function createModel(input: unknown, actor: CatalogActor, requestId: string): Promise<ModelRow> {
  const data = modelValues(parseCatalogInput(modelCreateSchema.strict(), input)) as z.output<typeof modelCreateSchema>;
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    await assertModelPublicId(tx, data.modelId);
    const [created] = await tx.insert(modelsTable).values(data).returning();
    await audit(tx, actor, requestId, "model", "created", created!.id, { modelId: created!.modelId });
    return created!;
  });
}
/** Changes the given fields; undefined when the model does not exist. An empty change writes nothing. */
export async function updateModel(id: string, input: unknown, actor: CatalogActor, requestId: string): Promise<ModelRow | undefined> {
  const data = modelValues(parseCatalogInput(modelUpdateSchema.strict(), input));
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    const [previous] = await tx.select().from(modelsTable).where(eq(modelsTable.id, id));
    if (!previous || !Object.keys(data).length) return previous;
    await validateModelWrite(tx, { ...previous, ...data } as ModelRow);
    const [changed] = await tx.update(modelsTable).set({ ...data, updatedAt: new Date() }).where(eq(modelsTable.id, id)).returning();
    if (changed) await audit(tx, actor, requestId, "model", "updated", changed.id, { modelId: changed.modelId, fields: Object.keys(data) });
    return changed;
  });
}
/** Deletes a model no alias references; null when it does not exist. */
export async function deleteModel(id: string, actor: CatalogActor, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    await assertModelUnreferenced(tx, id);
    const [deleted] = await tx.delete(modelsTable).where(eq(modelsTable.id, id)).returning({ id: modelsTable.id, modelId: modelsTable.modelId });
    if (deleted) await audit(tx, actor, requestId, "model", "deleted", deleted.id, { modelId: deleted.modelId });
    return deleted ?? null;
  });
}

async function writeAlias(tx: Tx, input: AliasInput, id: string | undefined, actor: CatalogActor, requestId: string, fields?: string[]) {
  const catalog = await readCatalog(tx);
  const previous = catalog.aliases.find((row) => row.id === id);
  if (id && !previous) throw new CatalogError(404, "Alias not found");
  const upstream = catalog.models.find((row) => row.id === input.upstreamModelId);
  if (!upstream) throw new CatalogError(400, "Upstream model not found; aliases must reference a model, not another alias");
  const reason = validateAliasSettings(upstream, input);
  if (reason) throw new CatalogError(400, reason);
  const row = { ...input, id: id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? new Date(), updatedAt: new Date() };
  catalog.aliases = [...catalog.aliases.filter((item) => item.id !== id), row];
  assertPublicNamespace(catalog);
  const [saved] = id ? await tx.update(modelAliasesTable).set(row).where(eq(modelAliasesTable.id, id)).returning() : await tx.insert(modelAliasesTable).values(row).returning();
  await audit(tx, actor, requestId, "alias", id ? "updated" : "created", row.id, { modelId: row.modelId, ...(fields && { fields }) });
  return aliasResponse(saved!);
}
/** Creates (without id) or replaces an alias with a complete, validated input. */
export async function saveAlias(input: AliasInput, id: string | undefined, actor: CatalogActor, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    return writeAlias(tx, input, id, actor, requestId);
  });
}
export async function createAlias(input: unknown, actor: CatalogActor, requestId: string) {
  return saveAlias(parseCatalogInput(aliasCreateSchema.strict(), input), undefined, actor, requestId);
}
/** Changes the given fields of an alias. An empty change writes nothing. */
export async function patchAlias(id: string, input: unknown, actor: CatalogActor, requestId: string) {
  const patch = parseCatalogInput(aliasPatchSchema.strict(), input);
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    const [previous] = await tx.select().from(modelAliasesTable).where(eq(modelAliasesTable.id, id));
    if (!previous) throw new CatalogError(404, "Alias not found");
    if (!Object.keys(patch).length) return aliasResponse(previous);
    const { modelId, name, description, upstreamModelId, reasoningSource, thinking, effort, enabled } = previous;
    const merged = parseCatalogInput(aliasInputSchema, { modelId, name, description, upstreamModelId, reasoningSource, thinking, effort, enabled, ...patch });
    return writeAlias(tx, merged, id, actor, requestId, Object.keys(patch));
  });
}

async function writeApp(tx: Tx, input: AppInput, id: string | undefined, actor: CatalogActor, requestId: string, fields?: string[]) {
  const catalog = await readCatalog(tx);
  const previous = catalog.apps.find((row) => row.id === id);
  if (id && !previous) throw new CatalogError(404, "App not found");
  for (const tier of input.tiers) {
    if (tier.aliasId && !catalog.aliases.some((alias) => alias.id === tier.aliasId)) throw new CatalogError(400, `Tier '${tier.name}' must reference an existing alias`);
  }
  const row = { ...input, id: id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? new Date(), updatedAt: new Date() };
  catalog.apps = [...catalog.apps.filter((item) => item.id !== id), row];
  assertPublicNamespace(catalog);
  const [saved] = id ? await tx.update(modelAppsTable).set(row).where(eq(modelAppsTable.id, id)).returning() : await tx.insert(modelAppsTable).values(row).returning();
  await audit(tx, actor, requestId, "app", id ? "updated" : "created", row.id, { name: row.name, ...(fields && { fields }) });
  return appResponse(saved!);
}
/** Creates (without id) or replaces an app with a complete, validated input. */
export async function saveApp(input: AppInput, id: string | undefined, actor: CatalogActor, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    return writeApp(tx, input, id, actor, requestId);
  });
}
export async function createApp(input: unknown, actor: CatalogActor, requestId: string) {
  return saveApp(parseCatalogInput(appCreateSchema.strict(), input), undefined, actor, requestId);
}
/** Changes the given fields of an app; tiers replace the whole list. An empty change writes nothing. */
export async function patchApp(id: string, input: unknown, actor: CatalogActor, requestId: string) {
  const patch = parseCatalogInput(appPatchSchema.strict(), input);
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    const [previous] = await tx.select().from(modelAppsTable).where(eq(modelAppsTable.id, id));
    if (!previous) throw new CatalogError(404, "App not found");
    if (!Object.keys(patch).length) return appResponse(previous);
    const { name, description, enabled, tiers } = previous;
    const merged = parseCatalogInput(appInputSchema, { name, description, enabled, tiers, ...patch });
    return writeApp(tx, merged, id, actor, requestId, Object.keys(patch));
  });
}
export async function deleteCatalogEntry(kind: "alias" | "app", id: string, actor: CatalogActor, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    if (kind === "alias") {
      const apps = await tx.select().from(modelAppsTable);
      const app = apps.find((row) => row.tiers.some((tier) => tier.aliasId === id));
      if (app) throw new CatalogError(409, `Alias is referenced by app '${app.name}'; remove or reassign its tiers first`);
    }
    const [deleted] = kind === "alias"
      ? await tx.delete(modelAliasesTable).where(eq(modelAliasesTable.id, id)).returning({ id: modelAliasesTable.id, label: modelAliasesTable.modelId })
      : await tx.delete(modelAppsTable).where(eq(modelAppsTable.id, id)).returning({ id: modelAppsTable.id, label: modelAppsTable.name });
    if (!deleted) throw new CatalogError(404, `${kind === "alias" ? "Alias" : "App"} not found`);
    await audit(tx, actor, requestId, kind, "deleted", id, kind === "alias" ? { modelId: deleted.label } : { name: deleted.label });
    return { success: true };
  });
}
