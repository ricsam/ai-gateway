export interface OidcDiscoveryMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  authorization_response_iss_parameter_supported?: boolean;
}

export function oidcDiscoveryUrl(issuer: string | undefined, explicitUrl: string | undefined): string | undefined {
  const configured = explicitUrl?.trim();
  if (configured) return configured;
  const normalizedIssuer = issuer?.trim().replace(/\/$/, "");
  return normalizedIssuer ? `${normalizedIssuer}/.well-known/openid-configuration` : undefined;
}

export function parseOidcDiscoveryMetadata(value: unknown, expectedIssuer: string): OidcDiscoveryMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Record<string, unknown>;
  if (
    metadata.issuer !== expectedIssuer
    || typeof metadata.authorization_endpoint !== "string"
    || typeof metadata.token_endpoint !== "string"
    || typeof metadata.jwks_uri !== "string"
  ) return null;

  return {
    issuer: expectedIssuer,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    jwks_uri: metadata.jwks_uri,
    ...(typeof metadata.authorization_response_iss_parameter_supported === "boolean"
      ? { authorization_response_iss_parameter_supported: metadata.authorization_response_iss_parameter_supported }
      : {}),
  };
}

export function requiresAuthorizationResponseIssuer(metadata: OidcDiscoveryMetadata): boolean {
  return metadata.authorization_response_iss_parameter_supported === true;
}

export async function fetchOidcDiscoveryMetadata(
  discoveryUrl: string,
  expectedIssuer: string,
  timeoutMs = 5000,
): Promise<{ response: Response; metadata: OidcDiscoveryMetadata | null }> {
  const response = await fetch(discoveryUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const value = response.ok ? await response.json() : null;
  return { response, metadata: parseOidcDiscoveryMetadata(value, expectedIssuer) };
}
