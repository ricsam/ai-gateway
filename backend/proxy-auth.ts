import { and, eq, gt, isNull, or } from "drizzle-orm";
import db from "@/db";
import { authenticateRequest } from "./auth";
import { extractBearerToken, hashApiKey } from "./api-key-utils";
import { apiKeysTable, userTable } from "./schema";
import { PROXY_SCOPES, type ProxyAuthResult } from "./proxy-principal";

export { PROXY_SCOPES, requireProxyScope } from "./proxy-principal";
export type { ProxyAuthResult, ProxyPrincipal, ProxyScope } from "./proxy-principal";

export async function authenticateApiKeyPrincipal(request: Request): Promise<ProxyAuthResult> {
  const rawKey = extractBearerToken(request);
  if (!rawKey) {
    return { ok: false, status: 401, message: "Missing API key", code: "missing_api_key" };
  }
  if (!rawKey.startsWith("llmp_")) {
    return { ok: false, status: 401, message: "Invalid API key", code: "invalid_api_key" };
  }

  const keyHash = await hashApiKey(rawKey);
  const now = new Date();
  const [credential] = await db
    .select({
      id: apiKeysTable.id,
      userId: apiKeysTable.userId,
      scopes: apiKeysTable.scopes,
      userEnabled: userTable.enabled,
      apiEnabled: userTable.apiEnabled,
    })
    .from(apiKeysTable)
    .innerJoin(userTable, eq(apiKeysTable.userId, userTable.id))
    .where(and(
      eq(apiKeysTable.keyHash, keyHash),
      eq(apiKeysTable.enabled, true),
      isNull(apiKeysTable.revokedAt),
      or(isNull(apiKeysTable.expiresAt), gt(apiKeysTable.expiresAt, now)),
    ))
    .limit(1);

  if (!credential) {
    return { ok: false, status: 401, message: "Invalid, expired, or revoked API key", code: "invalid_api_key" };
  }
  if (!credential.userEnabled) {
    return { ok: false, status: 403, message: "Account disabled", code: "account_disabled" };
  }
  if (!credential.apiEnabled) {
    return { ok: false, status: 403, message: "API access disabled", code: "api_access_disabled" };
  }

  // Authentication should not fail merely because this audit timestamp cannot be
  // persisted. The credential state was already checked in the query above.
  void db.update(apiKeysTable)
    .set({ lastUsedAt: now })
    .where(eq(apiKeysTable.id, credential.id))
    .catch((error) => console.warn("Could not update API key last-used timestamp", error));

  return {
    ok: true,
    principal: {
      userId: credential.userId,
      credentialType: "api_key",
      credentialId: credential.id,
      scopes: new Set(credential.scopes),
    },
  };
}

export async function authenticateSessionPrincipal(request: Request): Promise<ProxyAuthResult> {
  const session = await authenticateRequest(request);
  if (!session) return { ok: false, status: 401, message: "Unauthorized", code: "unauthorized" };
  return {
    ok: true,
    principal: {
      userId: session.userId,
      credentialType: "session",
      credentialId: session.userId,
      scopes: new Set(PROXY_SCOPES),
    },
  };
}
