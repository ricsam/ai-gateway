#!/usr/bin/env bun
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import db, { pool } from "../backend/db";
import { accountTable, sessionTable, userTable } from "../backend/schema";
import { normalizeUsername, validateLocalAccount } from "../backend/setup";

const [usernameInput, password] = process.argv.slice(2);
if (!usernameInput || !password) {
  console.error("Usage: bun scripts/recover-admin-password.ts <username> <new-password>");
  process.exit(1);
}
validateLocalAccount({ username: usernameInput, email: "recovery@example.com", name: "Recovery", password });
const username = normalizeUsername(usernameInput);
const passwordHash = await hashPassword(password);
const changed = await db.transaction(async (tx) => {
  const [user] = await tx.select().from(userTable).where(eq(userTable.username, username)).limit(1).for("update");
  if (!user) return false;
  await tx.update(userTable).set({ role: "admin", enabled: true, mustChangePassword: true, updatedAt: new Date() }).where(eq(userTable.id, user.id));
  const accounts = await tx.update(accountTable).set({ password: passwordHash, updatedAt: new Date() }).where(and(eq(accountTable.userId, user.id), eq(accountTable.providerId, "credential"))).returning();
  if (!accounts.length) await tx.insert(accountTable).values({ id: crypto.randomUUID(), accountId: user.id, providerId: "credential", userId: user.id, password: passwordHash, createdAt: new Date(), updatedAt: new Date() });
  await tx.delete(sessionTable).where(eq(sessionTable.userId, user.id));
  return true;
});
await pool.end();
if (!changed) { console.error(`No local user named ${username}`); process.exit(1); }
console.log(`Recovered administrator ${username}. The password must be changed after login.`);
