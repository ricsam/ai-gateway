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
