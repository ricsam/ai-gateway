import { hashPassword } from "better-auth/crypto";
import { serializeSignedCookie } from "better-call";
import { count, eq, sql } from "drizzle-orm";
import db from "./db";
import { auth } from "./auth";
import { accountTable, auditEventsTable, installationTable, userTable } from "./schema";

export interface SetupInput {
  username: string;
  email: string;
  name: string;
  password: string;
}

export class SetupError extends Error {
  constructor(message: string, public readonly status: 400 | 409 = 400) { super(message); }
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateLocalAccount(input: SetupInput): SetupInput {
  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) throw new SetupError("Username must be 3-40 letters, numbers, dots, underscores, or hyphens");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new SetupError("A valid email address is required");
  if (!name || name.length > 100) throw new SetupError("Display name is required and must not exceed 100 characters");
  if (input.password.length < 12 || input.password.length > 128) throw new SetupError("Password must be between 12 and 128 characters");
  if (!/[a-z]/i.test(input.password) || !/\d/.test(input.password)) throw new SetupError("Password must contain a letter and a number");
  return { username, email, name, password: input.password };
}

export async function getSetupStatus(): Promise<{ required: boolean; completedAt: string | null }> {
  const [installation] = await db.select({ setupCompletedAt: installationTable.setupCompletedAt }).from(installationTable).where(eq(installationTable.id, "main")).limit(1);
  const [users] = await db.select({ value: count() }).from(userTable);
  const required = !installation?.setupCompletedAt && (users?.value ?? 0) === 0;
  return { required, completedAt: installation?.setupCompletedAt?.toISOString() ?? null };
}

export async function createInitialAdministrator(input: SetupInput, requestId: string): Promise<{ id: string; username: string; email: string }> {
  const normalized = validateLocalAccount(input);
  const passwordHash = await hashPassword(normalized.password);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ai-gateway:first-setup'))`);
    const [installation] = await tx.select().from(installationTable).where(eq(installationTable.id, "main")).limit(1).for("update");
    const [users] = await tx.select({ value: count() }).from(userTable);
    if (!installation || installation.setupCompletedAt || (users?.value ?? 0) !== 0) throw new SetupError("Installation setup is already complete", 409);

    const now = new Date();
    const userId = crypto.randomUUID();
    await tx.insert(userTable).values({
      id: userId, username: normalized.username, displayUsername: input.username.trim(), name: normalized.name,
      email: normalized.email, emailVerified: true, role: "admin", enabled: true, apiEnabled: true,
      mustChangePassword: false, createdAt: now, updatedAt: now,
    });
    await tx.insert(accountTable).values({
      id: crypto.randomUUID(), accountId: userId, providerId: "credential", userId, password: passwordHash, createdAt: now, updatedAt: now,
    });
    await tx.update(installationTable).set({ setupCompletedAt: now, revision: installation.revision + 1, updatedAt: now }).where(eq(installationTable.id, "main"));
    await tx.insert(auditEventsTable).values({
      actorType: "setup", actorId: userId, action: "installation.setup.completed", targetType: "user", targetId: userId, requestId,
      metadata: { username: normalized.username, email: normalized.email },
    });
    return { id: userId, username: normalized.username, email: normalized.email };
  });
}

export async function handleSetup(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  if (request.method === "GET") return Response.json(await getSetupStatus(), { headers: { "x-request-id": requestId, "cache-control": "no-store" } });
  if (request.method !== "POST") return Response.json({ error: { code: "method_not_allowed", message: "Method not allowed", requestId } }, { status: 405 });
  try {
    const body = await request.json() as Partial<SetupInput>;
    const result = await createInitialAdministrator({
      username: body.username ?? "", email: body.email ?? "", name: body.name ?? "", password: body.password ?? "",
    }, requestId);
    const context = await auth.$context;
    const session = await context.internalAdapter.createSession(result.id, false);
    const cookie = context.authCookies.sessionToken;
    const setCookie = await serializeSignedCookie(cookie.name, session.token, context.secret, cookie.attributes);
    return Response.json({ user: result, next: "/admin" }, { status: 201, headers: { "x-request-id": requestId, "set-cookie": setCookie } });
  } catch (error) {
    const status = error instanceof SetupError ? error.status : 400;
    return Response.json({ error: { code: status === 409 ? "setup_closed" : "invalid_setup", message: error instanceof Error ? error.message : "Setup failed", requestId } }, { status, headers: { "x-request-id": requestId } });
  }
}
