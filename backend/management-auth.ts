import { and, eq, gt, isNull, or } from "drizzle-orm";
import db from "./db";
import env from "./env";
import { authenticateRequest } from "./auth";
import { extractBearerToken, hashApiKey } from "./api-key-utils";
import { managementApiKeysTable, userTable } from "./schema";

export const MANAGEMENT_SCOPES = [
  "users.read", "users.write", "groups.read", "groups.write", "auth.read", "auth.write",
  "branding.read", "branding.write", "aws.read", "aws.write", "models.read", "models.write",
  "settings.read", "settings.write", "usage.read", "management-keys.read", "management-keys.write", "audit.read",
  "api-keys.read", "api-keys.write",
] as const;
export type ManagementScope = typeof MANAGEMENT_SCOPES[number];

export interface ManagementPrincipal {
  actorType: "user" | "management_key";
  actorId: string;
  userId: string | null;
  scopes: ReadonlySet<string>;
}

export class ManagementAuthError extends Error {
  constructor(public readonly status: 401 | 403, public readonly code: string, message: string) { super(message); }
}

function hasScope(scopes: ReadonlySet<string>, required: string): boolean {
  return scopes.has("*") || scopes.has(required);
}

function assertOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin || new URL(origin).origin !== new URL(env.BASE_URL).origin) throw new ManagementAuthError(403, "invalid_origin", "Mutation origin is not allowed");
}

export async function requireManagementPrincipal(request: Request, scope: ManagementScope): Promise<ManagementPrincipal> {
  const token = extractBearerToken(request);
  if (token?.startsWith("aigm_")) {
    const keyHash = await hashApiKey(token);
    const now = new Date();
    const [key] = await db.select().from(managementApiKeysTable).where(and(
      eq(managementApiKeysTable.keyHash, keyHash), isNull(managementApiKeysTable.revokedAt),
      or(isNull(managementApiKeysTable.expiresAt), gt(managementApiKeysTable.expiresAt, now)),
    )).limit(1);
    if (!key) throw new ManagementAuthError(401, "invalid_management_key", "Invalid, expired, or revoked management key");
    if (!hasScope(new Set(key.scopes), scope)) throw new ManagementAuthError(403, "insufficient_scope", `Required scope: ${scope}`);
    void db.update(managementApiKeysTable).set({ lastUsedAt: now }).where(eq(managementApiKeysTable.id, key.id)).catch(() => undefined);
    return { actorType: "management_key", actorId: key.id, userId: null, scopes: new Set(key.scopes) };
  }

  assertOrigin(request);
  const session = await authenticateRequest(request);
  if (!session) throw new ManagementAuthError(401, "unauthorized", "Authentication required");
  const [user] = await db.select({ id: userTable.id, enabled: userTable.enabled, role: userTable.role })
    .from(userTable).where(eq(userTable.id, session.userId)).limit(1);
  if (!user?.enabled || user.role !== "admin") throw new ManagementAuthError(403, "administrator_required", "Enabled administrator required");
  return { actorType: "user", actorId: user.id, userId: user.id, scopes: new Set(["*"]) };
}
