// Management API resources as aigctl reads them, and lookups by name.
import { call, type ManagementClient, type Query } from "./client";
import { ApiError, CliError } from "./errors";

export interface Page<T> { data: T[]; pagination: { limit: number; offset: number; total: number } }

export interface User {
  id: string; username: string; name: string; email: string; role: "user" | "admin"; enabled: boolean;
  mustChangePassword: boolean; creditBalance: number; defaultMonthlyCredits: number; createdAt: string;
  groups: { id: string; name: string; role: string }[];
}

export interface Group { id: string; name: string; description: string | null; createdAt: string; memberCount?: number }

export interface GroupMember {
  userId: string; username: string; name: string; email: string; role: string; source: string; joinedAt: string;
  enabled: boolean; creditBalance: number; defaultMonthlyCredits: number;
}

export interface GroupDetails extends Group { updatedAt?: string; members: GroupMember[] }

export interface InferenceKey {
  id: string; userId: string; name: string; keyPrefix: string; scopes: string[]; enabled: boolean;
  expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null; createdAt: string;
}

export interface ManagementKey {
  id: string; name: string; keyPrefix: string; scopes: string[]; expiresAt: string | null; revokedAt: string | null;
  lastUsedAt: string | null; createdByUserId: string | null; createdAt: string;
}

export interface AuthProvider {
  id: string; type: "oidc" | "trusted_header"; providerKey: string; label: string; enabled: boolean; revision: number;
  config: Record<string, unknown>; secret: { configured: boolean }; lastTestedAt: string | null;
  lastTestSucceeded: boolean | null; lastTestMessage: string | null; createdAt: string; updatedAt: string;
}

/** A configured Bedrock model. `available`: API clients can use it (/v1/models lists it). */
export interface Model {
  id: string; modelId: string; name: string; description: string | null; provider: string;
  inputPricePerMTok: number; outputPricePerMTok: number; cacheReadPricePerMTok: number | null;
  cacheWrite5mPricePerMTok: number | null; cacheWrite1hPricePerMTok: number | null;
  contextWindow: number | null; maxOutputTokens: number; thinking: boolean; reasoningMode: string;
  defaultReasoningEffort: string | null; managedCache: boolean; region: string | null; enabled: boolean;
  available: boolean; createdAt: string; updatedAt: string;
}

/** A model alias: a public model ID with its own name and reasoning settings for an upstream model. */
export interface Alias {
  id: string; modelId: string; name: string; description: string | null; upstreamModelId: string;
  reasoningSource: "alias" | "client"; thinking: boolean; effort: string | null; enabled: boolean;
  available: boolean; createdAt: string; updatedAt: string;
}

export interface AppTier { name: string; aliasId: string | null; modelId: string; available: boolean }

/** An app: public model IDs <app>-<tier> whose tiers map to aliases. */
export interface App {
  id: string; name: string; description: string | null; enabled: boolean; tiers: AppTier[]; createdAt: string; updatedAt: string;
}

export async function listModels(client: ManagementClient): Promise<Model[]> {
  return (await call<{ data: Model[] }>(client, "GET", "/models")).data;
}
export async function listAliases(client: ManagementClient): Promise<Alias[]> {
  return (await call<{ data: Alias[] }>(client, "GET", "/model-aliases")).data;
}
export async function listApps(client: ManagementClient): Promise<App[]> {
  return (await call<{ data: App[] }>(client, "GET", "/model-apps")).data;
}

/** Finds an entry by an exact key (ID, model ID), else by a unique case-insensitive name. */
function findCatalogEntry<T extends { id: string; name: string }>(entries: readonly T[], reference: string, what: string, exact: (entry: T) => string[], describe: (entry: T) => string): T {
  const ref = reference.trim();
  if (!ref) throw new CliError(`A ${what} is required`);
  const match = entries.find((entry) => exact(entry).includes(ref));
  if (match) return match;
  const named = entries.filter((entry) => entry.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new CliError(`${named.length} ${what}s are named '${ref}'; use one of: ${named.map(describe).join(", ")}`);
  throw new CliError(`No ${what} '${ref}'`);
}

/** Finds a model by ID, Bedrock model ID or name. */
export async function resolveModel(client: ManagementClient, reference: string, models?: readonly Model[]): Promise<Model> {
  return findCatalogEntry(models ?? await listModels(client), reference, "model", (model) => [model.id, model.modelId], (model) => model.modelId);
}

/** Finds an alias by ID, public model ID or name. */
export async function resolveAlias(client: ManagementClient, reference: string, aliases?: readonly Alias[]): Promise<Alias> {
  return findCatalogEntry(aliases ?? await listAliases(client), reference, "alias", (alias) => [alias.id, alias.modelId], (alias) => alias.modelId);
}

/** Finds an app by ID or name. */
export async function resolveApp(client: ManagementClient, reference: string): Promise<App> {
  return findCatalogEntry(await listApps(client), reference, "app", (app) => [app.id, app.name], (app) => app.id);
}

/** Fetches every page of a paginated collection, or the first `max` items. */
export async function listAll<T>(client: ManagementClient, path: string, query: Query = {}, max = Infinity, start = 0): Promise<{ items: T[]; total: number }> {
  const items: T[] = [];
  let offset = start;
  let total = 0;
  for (;;) {
    const limit = Math.min(100, max - items.length);
    if (limit <= 0) break;
    const page = await call<Page<T>>(client, "GET", path, { query: { ...query, limit, offset } });
    if (!Array.isArray(page.data) || typeof page.pagination?.total !== "number") throw new CliError(`Unexpected response from ${client.target} for ${path}: not a management API list`);
    items.push(...page.data);
    total = page.pagination.total;
    offset += page.data.length;
    if (!page.data.length || offset >= total) break;
  }
  return { items, total };
}

async function getOrNull<T>(client: ManagementClient, path: string): Promise<T | null> {
  try {
    return (await call<{ data: T }>(client, "GET", path)).data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Finds a user by ID, username or email. */
export async function resolveUser(client: ManagementClient, reference: string): Promise<User> {
  const ref = reference.trim();
  if (!ref) throw new CliError("A user (ID, username or email) is required");
  const byId = await getOrNull<User>(client, `/users/${encodeURIComponent(ref)}`);
  if (byId) return byId;
  const normalized = ref.toLowerCase();
  let offset = 0;
  for (;;) {
    const page = await call<Page<User>>(client, "GET", "/users", { query: { search: ref, limit: 100, offset } });
    const match = page.data.find((user) => user.username === normalized || user.email === normalized);
    if (match) return match;
    offset += page.data.length;
    if (!page.data.length || offset >= page.pagination.total) break;
  }
  throw new CliError(`No user with the ID, username or email '${ref}'`);
}

/** Resolves each reference once; a user named twice counts once. */
export async function resolveUsers(client: ManagementClient, references: readonly string[]): Promise<User[]> {
  const users = new Map<string, User>();
  for (const reference of references) {
    const user = await resolveUser(client, reference);
    users.set(user.id, user);
  }
  return [...users.values()];
}

/** Finds a group by ID or name (case-insensitive). */
export async function resolveGroup(client: ManagementClient, reference: string): Promise<Group> {
  const ref = reference.trim();
  if (!ref) throw new CliError("A group (ID or name) is required");
  const byId = await getOrNull<GroupDetails>(client, `/groups/${encodeURIComponent(ref)}`);
  if (byId) return byId;
  const { items } = await listAll<Group>(client, "/groups");
  const match = items.find((group) => group.name.toLowerCase() === ref.toLowerCase());
  if (!match) throw new CliError(`No group with the ID or name '${ref}'`);
  return match;
}

/** Resolves each reference once; a group named twice counts once. */
export async function resolveGroups(client: ManagementClient, references: readonly string[]): Promise<Group[]> {
  const groups = new Map<string, Group>();
  for (const reference of references) {
    const group = await resolveGroup(client, reference);
    groups.set(group.id, group);
  }
  return [...groups.values()];
}

export async function getGroupDetails(client: ManagementClient, id: string): Promise<GroupDetails> {
  return (await call<{ data: GroupDetails }>(client, "GET", `/groups/${encodeURIComponent(id)}`)).data;
}

/** Finds a login provider by ID or provider key. */
export async function resolveProvider(client: ManagementClient, reference: string): Promise<AuthProvider> {
  const ref = reference.trim();
  const { data } = await call<{ data: AuthProvider[] }>(client, "GET", "/auth/providers");
  const match = data.find((provider) => provider.id === ref || provider.providerKey === ref.toLowerCase());
  if (!match) throw new CliError(`No login provider with the ID or key '${ref}'`);
  return match;
}

export type KeyStatus = "active" | "expired" | "revoked";

export function keyStatus(key: { enabled?: boolean; expiresAt: string | null; revokedAt: string | null }, now = new Date()): KeyStatus {
  if (key.revokedAt || key.enabled === false) return "revoked";
  if (key.expiresAt && new Date(key.expiresAt) <= now) return "expired";
  return "active";
}

/**
 * Finds a key by ID, prefix (as listed) or name. A name must belong to exactly
 * one key that is not revoked.
 */
export function findKey<T extends { id: string; name: string; keyPrefix: string; enabled?: boolean; expiresAt: string | null; revokedAt: string | null }>(keys: readonly T[], reference: string, what: string): T {
  const ref = reference.trim();
  const exact = keys.find((key) => key.id === ref) ?? keys.find((key) => key.keyPrefix === ref);
  if (exact) return exact;
  const named = keys.filter((key) => key.name === ref && keyStatus(key) !== "revoked");
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new CliError(`${named.length} ${what}s are named '${ref}'; use the ID or prefix (${named.map((key) => key.keyPrefix).join(", ")})`);
  if (keys.some((key) => key.name === ref)) throw new CliError(`Every ${what} named '${ref}' is already revoked`);
  throw new CliError(`No ${what} with the ID, prefix or name '${ref}'`);
}
