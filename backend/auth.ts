import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { and, count, eq, ne, sql } from "drizzle-orm";
import db from "@/db";
import env from "@/env";
import { assertAdministratorUpdateIsSafe, shouldBootstrapAdmin } from "./auth-policy";
import * as schema from "./schema";
import { accountTable, userTable } from "./schema";

const authBaseUrl = new URL("/api/auth", `${env.BASE_URL}/`).toString();
const bootstrapAdminPolicy = {
  subjects: env.BOOTSTRAP_ADMIN_SUBJECTS,
  emails: env.BOOTSTRAP_ADMIN_EMAILS,
};

export async function reconcileBootstrapAdmin(userId: string): Promise<void> {
  const [identity] = await db
    .select({ subject: accountTable.accountId })
    .from(accountTable)
    .where(and(eq(accountTable.userId, userId), eq(accountTable.providerId, env.OIDC_PROVIDER_ID)))
    .limit(1);
  const [user] = await db
    .select({ email: userTable.email, emailVerified: userTable.emailVerified, role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  if (user && user.role !== "admin" && shouldBootstrapAdmin({
    subject: identity?.subject ?? null,
    email: user.email,
    emailVerified: user.emailVerified,
  }, bootstrapAdminPolicy)) {
    await db.update(userTable).set({ role: "admin", updatedAt: new Date() }).where(eq(userTable.id, userId));
  }
}

export async function updateUserAccessSafely(
  targetUserId: string,
  updates: { role?: "user" | "admin"; enabled?: boolean; apiEnabled?: boolean },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serialize administrator role/access changes so concurrent requests cannot
    // both remove what each observed as the other remaining administrator.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('llm-proxy:admin-updates'))`);
    const [target] = await tx
      .select({ role: userTable.role, enabled: userTable.enabled })
      .from(userTable)
      .where(eq(userTable.id, targetUserId))
      .limit(1)
      .for("update");
    if (!target) return false;

    const [remaining] = await tx
      .select({ value: count() })
      .from(userTable)
      .where(and(eq(userTable.role, "admin"), eq(userTable.enabled, true), ne(userTable.id, targetUserId)));
    assertAdministratorUpdateIsSafe(target, updates, remaining?.value ?? 0);

    await tx
      .update(userTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userTable.id, targetUserId));
    return true;
  });
}

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: authBaseUrl,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.userTable,
      session: schema.sessionTable,
      account: schema.accountTable,
      verification: schema.verificationTable,
    },
  }),
  databaseHooks: {
    account: {
      create: {
        after: async (account) => {
          if (account.providerId === env.OIDC_PROVIDER_ID) {
            await reconcileBootstrapAdmin(account.userId);
          }
        },
      },
    },
  },
  user: {
    additionalFields: {
      role: { type: "string", required: false, defaultValue: "user", input: false, returned: true },
      creditBalance: { type: "number", required: false, defaultValue: 0, input: false, returned: true },
      defaultMonthlyCredits: { type: "number", required: false, defaultValue: 0, input: false, returned: true },
      enabled: { type: "boolean", required: false, defaultValue: true, input: false, returned: true },
      apiEnabled: { type: "boolean", required: false, defaultValue: true, input: false, returned: true },
    },
  },
  plugins: [
    genericOAuth({
      config: [
        {
          providerId: env.OIDC_PROVIDER_ID,
          discoveryUrl: env.OIDC_DISCOVERY_URL,
          issuer: env.OIDC_ISSUER,
          requireIssuerValidation: env.OIDC_STRICT_ISSUER_VALIDATION,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          scopes: env.OIDC_SCOPES,
          pkce: env.OIDC_PKCE,
          mapProfileToUser: (profile) => ({
            email: typeof profile.email === "string" ? profile.email.trim().toLowerCase() : undefined,
            emailVerified: profile.email_verified === true,
            name: typeof profile.name === "string" && profile.name.trim()
              ? profile.name
              : typeof profile.preferred_username === "string" && profile.preferred_username.trim()
                ? profile.preferred_username
                : typeof profile.email === "string"
                  ? profile.email
                  : undefined,
            image: typeof profile.picture === "string" ? profile.picture : undefined,
          }),
          overrideUserInfo: true,
        },
      ],
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;

export async function authenticateRequest(request: Request): Promise<{ userId: string } | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;

  await reconcileBootstrapAdmin(session.user.id);
  const [user] = await db
    .select({ enabled: userTable.enabled })
    .from(userTable)
    .where(eq(userTable.id, session.user.id))
    .limit(1);
  return user?.enabled ? { userId: session.user.id } : null;
}
