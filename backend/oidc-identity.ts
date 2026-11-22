import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

export interface OidcIssuerPolicy {
  providerKey: string;
  issuer: string;
  requireAuthorizationResponseIssuer: boolean;
}

export type AuthorizationResponseIssuerResult = "ok" | "issuer_missing" | "issuer_mismatch";

/**
 * RFC 9207 authorization-response issuer check against the administrator's
 * configured issuer. Better Auth 1.7 compares a present `iss` with the issuer
 * from discovery, but no longer rejects a missing `iss` from a provider that
 * advertises `authorization_response_iss_parameter_supported`, so the gateway
 * keeps enforcing both conditions itself.
 */
export function checkAuthorizationResponseIssuer(policy: OidcIssuerPolicy, iss: unknown): AuthorizationResponseIssuerResult {
  const received = typeof iss === "string" && iss.length > 0 ? iss : undefined;
  if (received === undefined) return policy.requireAuthorizationResponseIssuer ? "issuer_missing" : "ok";
  return received === policy.issuer ? "ok" : "issuer_mismatch";
}

/**
 * Better Auth 1.7 takes provider identity from `accountSubject`, never from
 * `mapProfileToUser`. OIDC discovery providers default to the verified ID-token
 * `sub`, so a resolver is installed only for a custom subject claim. A missing
 * custom claim fails closed instead of silently falling back to another claim,
 * which could change which local account an identity resolves to.
 */
export function oidcAccountSubject(subjectClaim: string) {
  if (subjectClaim === "sub") return undefined;
  return ({ profile }: { profile: Record<string, unknown> }): string => {
    const value = profile[subjectClaim];
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : "";
  };
}

export function oidcIssuerPolicyPlugin(policies: OidcIssuerPolicy[], errorURL: string): BetterAuthPlugin {
  const byKey = new Map(policies.map((policy) => [policy.providerKey, policy]));
  return {
    id: "ai-gateway-oidc-issuer-policy",
    hooks: {
      before: [{
        matcher: (context) => context.path === "/callback/:id" && byKey.has(String(context.params?.id ?? "")),
        handler: createAuthMiddleware(async (ctx) => {
          const policy = byKey.get(String(ctx.params?.id ?? ""));
          if (!policy) return;
          const query = (ctx.query ?? {}) as Record<string, unknown>;
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (query.error || body.error) return;
          const result = checkAuthorizationResponseIssuer(policy, query.iss ?? body.iss);
          if (result === "ok") return;
          ctx.context.logger.error(`OIDC authorization response rejected: ${result}`, { providerId: policy.providerKey, expected: policy.issuer });
          const url = new URL(errorURL);
          url.searchParams.set("error", "oidc");
          url.searchParams.set("reason", result);
          throw ctx.redirect(url.toString());
        }),
      }],
    },
  };
}
