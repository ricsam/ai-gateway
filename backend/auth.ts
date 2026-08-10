import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { username } from "better-auth/plugins/username";
import { eq } from "drizzle-orm";
import db from "@/db";
import env from "@/env";
import * as schema from "./schema";
import { getOidcRuntimeProviders } from "./auth-provider-runtime";
import { trustedEmailLinkingProviders } from "./oidc-account-linking";
import { userTable } from "./schema";

const authBaseUrl = new URL("/api/auth", `${env.BASE_URL}/`).toString();
let authRuntime: { fingerprint: string; instance: ReturnType<typeof buildAuth> } | null = null;

function buildAuth(providers: Awaited<ReturnType<typeof getOidcRuntimeProviders>>) {
  const trustedProviders = trustedEmailLinkingProviders(providers);
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: authBaseUrl,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: schema.userTable, session: schema.sessionTable, account: schema.accountTable, verification: schema.verificationTable },
    }),
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: false },
    account: { accountLinking: {
      disableImplicitLinking: trustedProviders.length === 0,
      trustedProviders,
    } },
    user: { additionalFields: {
      role: { type: "string", required: false, defaultValue: "user", input: false, returned: true },
      creditBalance: { type: "number", required: false, defaultValue: 0, input: false, returned: true },
      defaultMonthlyCredits: { type: "number", required: false, defaultValue: 0, input: false, returned: true },
      enabled: { type: "boolean", required: false, defaultValue: true, input: false, returned: true },
      apiEnabled: { type: "boolean", required: false, defaultValue: true, input: false, returned: true },
      mustChangePassword: { type: "boolean", required: false, defaultValue: false, input: false, returned: true },
    } },
    plugins: [
      username({ minUsernameLength: 3, maxUsernameLength: 40, usernameValidator: (value) => /^[a-z0-9][a-z0-9._-]*$/i.test(value), usernameNormalization: (value) => value.trim().toLowerCase() }),
      ...(providers.length ? [genericOAuth({ config: providers.map((provider) => ({
        providerId: provider.providerKey, discoveryUrl: provider.discoveryUrl, issuer: provider.issuer,
        requireIssuerValidation: provider.requireAuthorizationResponseIssuer, clientId: provider.clientId,
        clientSecret: provider.clientSecret, scopes: provider.scopes, pkce: provider.pkce,
        disableImplicitSignUp: true, disableSignUp: !provider.autoProvision, overrideUserInfo: false,
        mapProfileToUser: (profile: Record<string, unknown>) => {
          const claim = (name: string) => profile[name];
          const subjectValue = claim(provider.claims.subject) ?? profile.sub ?? profile.id;
          const emailValue = claim(provider.claims.email);
          const nameValue = claim(provider.claims.name);
          const usernameValue = claim(provider.claims.username);
          const email = typeof emailValue === "string" ? emailValue.trim().toLowerCase() : undefined;
          const preferred = typeof usernameValue === "string" ? usernameValue : email?.split("@")[0];
          const username = `${(preferred || "external").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24) || "external"}-${crypto.randomUUID().slice(0, 8)}`;
          return {
            id: subjectValue === undefined ? undefined : String(subjectValue),
            email,
            emailVerified: profile.email_verified === true,
            name: typeof nameValue === "string" ? nameValue : email,
            image: typeof profile.picture === "string" ? profile.picture : undefined,
            username,
            displayUsername: preferred || username,
          } as never;
        },
      })) })] : []),
    ],
  });
}

export const auth = buildAuth([]);

export async function getRuntimeAuth() {
  const providers = await getOidcRuntimeProviders();
  const fingerprint = providers.map((provider) => `${provider.id}:${provider.revision}`).join("|");
  if (!authRuntime || authRuntime.fingerprint !== fingerprint) authRuntime = { fingerprint, instance: providers.length ? buildAuth(providers) : auth };
  return authRuntime.instance;
}

export type Session = typeof auth.$Infer.Session;
export async function authenticateRequest(request: Request): Promise<{ userId: string; mustChangePassword: boolean } | null> {
  const runtime = await getRuntimeAuth(); const session = await runtime.api.getSession({ headers: request.headers });
  if (!session) return null;
  const [user] = await db.select({ enabled: userTable.enabled, mustChangePassword: userTable.mustChangePassword }).from(userTable).where(eq(userTable.id, session.user.id)).limit(1);
  return user?.enabled ? { userId: session.user.id, mustChangePassword: user.mustChangePassword } : null;
}
