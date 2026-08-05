export const PROXY_SCOPES = ["ai.invoke", "models.read", "credits.read"] as const;
export type ProxyScope = (typeof PROXY_SCOPES)[number];

export interface ProxyPrincipal {
  userId: string;
  credentialType: "api_key" | "session";
  credentialId: string;
  scopes: ReadonlySet<string>;
}

export type ProxyAuthResult =
  | { ok: true; principal: ProxyPrincipal }
  | { ok: false; status: 401 | 403; message: string; code: string };

export function requireProxyScope(result: ProxyAuthResult, scope: ProxyScope): ProxyAuthResult {
  if (!result.ok) return result;
  if (!result.principal.scopes.has(scope)) {
    return { ok: false, status: 403, message: `Missing required scope: ${scope}`, code: "insufficient_scope" };
  }
  return result;
}
