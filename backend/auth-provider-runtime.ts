import { eq } from "drizzle-orm";
import db from "./db";
import { authProvidersTable } from "./schema";
import { decryptSetting } from "./settings-crypto";

export interface OidcRuntimeProvider {
  id: string; providerKey: string; label: string; revision: number; issuer?: string; discoveryUrl?: string;
  clientId: string; clientSecret?: string; scopes: string[]; pkce: boolean; strictIssuerValidation: boolean;
  autoProvision: boolean; claims: { subject: string; email: string; name: string; username: string };
}

let cache: { fingerprint: string; providers: OidcRuntimeProvider[] } | null = null;

export function invalidateAuthProviderRuntime(): void { cache = null; }

export async function getOidcRuntimeProviders(): Promise<OidcRuntimeProvider[]> {
  const records = await db.select().from(authProvidersTable).where(eq(authProvidersTable.type, "oidc"));
  const enabled = records.filter((record) => record.enabled);
  const fingerprint = enabled.map((record) => `${record.id}:${record.revision}`).sort().join("|");
  if (cache?.fingerprint === fingerprint) return cache.providers;
  const providers = await Promise.all(enabled.map(async (record) => {
    const config = record.config as Record<string, unknown>;
    return {
      id: record.id, providerKey: record.providerKey, label: record.label, revision: record.revision,
      issuer: typeof config.issuer === "string" ? config.issuer : undefined,
      discoveryUrl: typeof config.discoveryUrl === "string" ? config.discoveryUrl : undefined,
      clientId: typeof config.clientId === "string" ? config.clientId : "",
      clientSecret: record.secretEnvelope ? await decryptSetting(record.secretEnvelope, `auth-provider:${record.providerKey}`) : undefined,
      scopes: Array.isArray(config.scopes) ? config.scopes.filter((value): value is string => typeof value === "string") : ["openid", "profile", "email"],
      pkce: config.pkce !== false, strictIssuerValidation: true,
      autoProvision: config.autoProvision !== false,
      claims: {
        subject: typeof config.subjectClaim === "string" ? config.subjectClaim : "sub",
        email: typeof config.emailClaim === "string" ? config.emailClaim : "email",
        name: typeof config.nameClaim === "string" ? config.nameClaim : "name",
        username: typeof config.usernameClaim === "string" ? config.usernameClaim : "preferred_username",
      },
    };
  }));
  cache = { fingerprint, providers };
  return providers;
}
