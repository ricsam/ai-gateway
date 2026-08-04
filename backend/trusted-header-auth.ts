import { timingSafeEqual } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { serializeSignedCookie } from "better-call";
import { and, eq } from "drizzle-orm";
import db from "./db";
import { getRuntimeAuth } from "./auth";
import { accountTable, authProvidersTable, userTable } from "./schema";
import { decryptSetting } from "./settings-crypto";
import { normalizeEmail, normalizeUsername } from "./setup";

function constantTimeSecretEqual(actual: string, expected: string): boolean {
  const actualDigest = Buffer.from(new Bun.CryptoHasher("sha256").update(actual).digest());
  const expectedDigest = Buffer.from(new Bun.CryptoHasher("sha256").update(expected).digest());
  return timingSafeEqual(actualDigest, expectedDigest);
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split("."); if (parts.length !== 4) return null;
  const numbers = parts.map(Number); if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return numbers.reduce((total, part) => total * 256 + part, 0) >>> 0;
}
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split("/"); const ipNumber = ipv4ToNumber(ip); const networkNumber = ipv4ToNumber(network ?? "");
  if (ipNumber === null || networkNumber === null) return ip === network;
  const prefix = prefixText === undefined ? 32 : Number(prefixText); if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (networkNumber & mask);
}

export async function handleTrustedHeaderSignIn(request: Request, providerKey: string): Promise<Response> {
  const [provider] = await db.select().from(authProvidersTable).where(and(eq(authProvidersTable.providerKey, providerKey), eq(authProvidersTable.type, "trusted_header"), eq(authProvidersTable.enabled, true))).limit(1);
  if (!provider?.secretEnvelope) return Response.json({ error: "Trusted-header provider is unavailable" }, { status: 404 });
  const config = provider.config as Record<string, unknown>;
  const secretHeader = typeof config.secretHeader === "string" ? config.secretHeader.toLowerCase() : "x-llm-proxy-proxy-secret";
  const suppliedSecret = request.headers.get(secretHeader) ?? "";
  const expectedSecret = await decryptSetting(provider.secretEnvelope, `auth-provider:${provider.providerKey}`);
  if (!suppliedSecret || !constantTimeSecretEqual(suppliedSecret, expectedSecret)) return Response.json({ error: "Trusted proxy authentication failed" }, { status: 401 });

  const sourceCidrs = Array.isArray(config.sourceCidrs) ? config.sourceCidrs.filter((value): value is string => typeof value === "string") : [];
  const sourceIp = request.headers.get("x-llm-proxy-peer-ip")?.trim() || "";
  if (!sourceCidrs.length || !sourceIp || !sourceCidrs.some((cidr) => ipMatchesCidr(sourceIp, cidr))) return Response.json({ error: "Trusted proxy source is not allowed" }, { status: 403 });

  const headerName = (key: string, fallback: string) => typeof config[key] === "string" ? String(config[key]).toLowerCase() : fallback;
  const subject = request.headers.get(headerName("subjectHeader", "x-auth-subject"))?.trim();
  const email = normalizeEmail(request.headers.get(headerName("emailHeader", "x-auth-email")) ?? "");
  const name = request.headers.get(headerName("nameHeader", "x-auth-name"))?.trim() || email;
  if (!subject || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: "Required trusted identity headers are invalid" }, { status: 400 });

  const [identity] = await db.select({ userId: accountTable.userId }).from(accountTable).where(and(eq(accountTable.providerId, provider.providerKey), eq(accountTable.accountId, subject))).limit(1);
  let userId = identity?.userId;
  if (!userId) {
    if (config.autoProvision === false) return Response.json({ error: "External identity is not provisioned" }, { status: 403 });
    const baseUsername = normalizeUsername(String(request.headers.get(headerName("usernameHeader", "x-auth-username")) || email.split("@")[0] || "user")).replace(/[^a-z0-9._-]/g, "").slice(0, 32) || "user";
    const now = new Date(); userId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      let username = baseUsername; let suffix = 0;
      while ((await tx.select({ id: userTable.id }).from(userTable).where(eq(userTable.username, username)).limit(1)).length) username = `${baseUsername.slice(0, 27)}-${++suffix}`;
      await tx.insert(userTable).values({ id: userId!, username, displayUsername: username, email, emailVerified: true, name, role: "user", enabled: true, apiEnabled: true, createdAt: now, updatedAt: now });
      await tx.insert(accountTable).values({ id: crypto.randomUUID(), accountId: subject, providerId: provider.providerKey, userId: userId!, password: await hashPassword(crypto.randomUUID()), createdAt: now, updatedAt: now });
    });
  }
  const [user] = await db.select({ enabled: userTable.enabled }).from(userTable).where(eq(userTable.id, userId)).limit(1);
  if (!user?.enabled) return Response.json({ error: "Account disabled" }, { status: 403 });
  const runtimeAuth = await getRuntimeAuth(); const context = await runtimeAuth.$context; const session = await context.internalAdapter.createSession(userId, false); const cookie = context.authCookies.sessionToken;
  const setCookie = await serializeSignedCookie(cookie.name, session.token, context.secret, cookie.attributes);
  return Response.json({ success: true, next: "/chat" }, { headers: { "set-cookie": setCookie, "cache-control": "no-store" } });
}
