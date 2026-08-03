import { authenticateApiKeyPrincipal } from "./proxy-auth";

export interface ApiKeyAuth {
  userId: string;
  keyId: string;
  scopes: ReadonlySet<string>;
}

/** @deprecated New handlers should use authenticateApiKeyPrincipal and requireProxyScope. */
export async function authenticateApiKey(request: Request): Promise<ApiKeyAuth | null> {
  const result = await authenticateApiKeyPrincipal(request);
  if (!result.ok) return null;
  return {
    userId: result.principal.userId,
    keyId: result.principal.credentialId,
    scopes: result.principal.scopes,
  };
}
