import { asc, eq, sql } from "drizzle-orm";
import db from "./db";
import { auditEventsTable, modelAliasesTable, modelAppsTable, modelsTable } from "./schema";
import { validateAliasSettings } from "../shared/alias-options";
import type { AliasInput, AppInput } from "../shared/alias-contract";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Catalog = { models: typeof modelsTable.$inferSelect[]; aliases: typeof modelAliasesTable.$inferSelect[]; apps: typeof modelAppsTable.$inferSelect[] };
export class CatalogError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export function catalogErrorResponse(error: unknown) {
  if (!(error instanceof CatalogError)) throw error;
  return { status: error.status, body: { error: error.message } };
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
export async function validateModelWrite(tx: Tx, model: typeof modelsTable.$inferSelect) {
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
export function aliasResponse(row: typeof modelAliasesTable.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
export function appResponse(row: typeof modelAppsTable.$inferSelect) {
  return { ...row, tiers: row.tiers.map((tier) => ({ ...tier, modelId: `${row.name}-${tier.name}` })), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
async function audit(tx: Tx, actorId: string, requestId: string, kind: string, action: string, id: string) {
  await tx.insert(auditEventsTable).values({ actorType: "user", actorId, requestId, action: `${kind}.${action}`, targetType: kind, targetId: id });
}
export async function saveAlias(input: AliasInput, id: string | undefined, actorId: string, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
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
    await audit(tx, actorId, requestId, "alias", id ? "updated" : "created", row.id);
    return aliasResponse(saved!);
  });
}
export async function saveApp(input: AppInput, id: string | undefined, actorId: string, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
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
    await audit(tx, actorId, requestId, "app", id ? "updated" : "created", row.id);
    return appResponse(saved!);
  });
}
export async function deleteCatalogEntry(kind: "alias" | "app", id: string, actorId: string, requestId: string) {
  return db.transaction(async (tx) => {
    await lockModelCatalog(tx);
    if (kind === "alias") {
      const apps = await tx.select().from(modelAppsTable);
      const app = apps.find((row) => row.tiers.some((tier) => tier.aliasId === id));
      if (app) throw new CatalogError(409, `Alias is referenced by app '${app.name}'; remove or reassign its tiers first`);
    }
    const table = kind === "alias" ? modelAliasesTable : modelAppsTable;
    const [deleted] = await tx.delete(table).where(eq(table.id, id)).returning({ id: table.id });
    if (!deleted) throw new CatalogError(404, `${kind === "alias" ? "Alias" : "App"} not found`);
    await audit(tx, actorId, requestId, kind, "deleted", id);
    return { success: true };
  });
}
