export interface OidcEmailLinkingProvider {
  providerKey: string;
  linkExistingUsersByEmail: boolean;
}

/**
 * Email-based linking is intentionally fail-closed. It is available only when
 * the sole enabled OIDC provider has been explicitly trusted for migration.
 */
export function trustedEmailLinkingProviders(providers: OidcEmailLinkingProvider[]): string[] {
  if (providers.length !== 1 || !providers[0]?.linkExistingUsersByEmail) return [];
  return [providers[0].providerKey];
}
