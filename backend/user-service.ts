import { hashPassword } from "better-auth/crypto";
import { and, count, eq, inArray, ne, sql } from "drizzle-orm";
import db from "./db";
import { accountTable, auditEventsTable, creditEventsTable, groupMembersTable, groupsTable, sessionTable, userTable } from "./schema";
import { normalizeEmail, normalizeUsername, validateLocalAccount } from "./setup";
import type { ManagementPrincipal } from "./management-auth";

export interface UserCreateInput {
  username: string; email: string; name: string; password: string; role?: "user" | "admin";
  enabled?: boolean; apiEnabled?: boolean; mustChangePassword?: boolean; creditBalance?: number; defaultMonthlyCredits?: number;
  groupIds?: string[];
}

async function audit(tx: any, principal: ManagementPrincipal, action: string, targetId: string, requestId: string, metadata: Record<string, unknown> = {}) {
  await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action, targetType: "user", targetId, requestId, metadata });
}

export async function createLocalUser(input: UserCreateInput, principal: ManagementPrincipal, requestId: string) {
  const valid = validateLocalAccount(input);
  const passwordHash = await hashPassword(valid.password);
  const creditBalance = input.creditBalance ?? 0;
  const defaultMonthlyCredits = input.defaultMonthlyCredits ?? 0;
  if (input.role !== undefined && !["user", "admin"].includes(input.role)) throw new Error("Role must be user or admin");
  for (const field of ["enabled", "apiEnabled", "mustChangePassword"] as const) if (input[field] !== undefined && typeof input[field] !== "boolean") throw new Error(`${field} must be a boolean`);
  if (!Number.isFinite(creditBalance) || !Number.isFinite(defaultMonthlyCredits) || creditBalance < 0 || defaultMonthlyCredits < 0) throw new Error("Credits cannot be negative or invalid");
  return db.transaction(async (tx) => {
    const now = new Date(); const id = crypto.randomUUID();
    const [user] = await tx.insert(userTable).values({
      id, username: valid.username, displayUsername: input.username.trim(), email: valid.email, name: valid.name, emailVerified: true,
      role: input.role ?? "user", enabled: input.enabled ?? true, apiEnabled: input.apiEnabled ?? true,
      mustChangePassword: input.mustChangePassword ?? true, creditBalance, defaultMonthlyCredits, createdAt: now, updatedAt: now,
    }).returning();
    await tx.insert(accountTable).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id, password: passwordHash, createdAt: now, updatedAt: now });
    if (creditBalance > 0) await tx.insert(creditEventsTable).values({
      userId: id, requestId, source: "admin", type: "admin_adjustment", description: "Initial administrator-assigned balance", creditsAdded: creditBalance,
    });
    if (input.groupIds?.length) {
      const groupIds = [...new Set(input.groupIds)];
      const existing = await tx.select({ id: groupsTable.id }).from(groupsTable).where(inArray(groupsTable.id, groupIds));
      if (existing.length !== groupIds.length) throw new Error("One or more selected groups do not exist");
      await tx.insert(groupMembersTable).values(groupIds.map((groupId) => ({ groupId, userId: id, role: "member" })));
    }
    await audit(tx, principal, "user.created", id, requestId, { username: valid.username, role: input.role ?? "user" });
    return user!;
  });
}

export async function updateUser(id: string, updates: Partial<Omit<UserCreateInput, "password" | "groupIds">>, principal: ManagementPrincipal, requestId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('llm-proxy:admin-updates'))`);
    const [target] = await tx.select().from(userTable).where(eq(userTable.id, id)).limit(1).for("update");
    if (!target) return null;
    const role = updates.role ?? target.role; const enabled = updates.enabled ?? target.enabled;
    if (target.role === "admin" && target.enabled && (role !== "admin" || !enabled)) {
      const [other] = await tx.select({ value: count() }).from(userTable).where(and(eq(userTable.role, "admin"), eq(userTable.enabled, true), ne(userTable.id, id)));
      if ((other?.value ?? 0) === 0) throw new Error("Cannot remove or disable the final enabled administrator");
    }
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.username !== undefined) {
      const username = normalizeUsername(updates.username);
      if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(username)) throw new Error("Username must be 3-40 letters, numbers, dots, underscores, or hyphens");
      values.username = username;
      values.displayUsername = updates.username.trim();
    }
    if (updates.email !== undefined) {
      const email = normalizeEmail(updates.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("A valid email address is required");
      values.email = email;
    }
    if (updates.name !== undefined && (!updates.name.trim() || updates.name.trim().length > 100)) throw new Error("Display name is required and must not exceed 100 characters");
    if (updates.role !== undefined && !["user", "admin"].includes(updates.role)) throw new Error("Role must be user or admin");
    for (const field of ["enabled", "apiEnabled", "mustChangePassword"] as const) if (updates[field] !== undefined && typeof updates[field] !== "boolean") throw new Error(`${field} must be a boolean`);
    for (const field of ["name", "role", "enabled", "apiEnabled", "mustChangePassword", "creditBalance", "defaultMonthlyCredits"] as const) if (updates[field] !== undefined) values[field] = field === "name" ? String(updates[field]).trim() : updates[field];
    for (const field of ["creditBalance", "defaultMonthlyCredits"] as const) {
      const value = values[field] as number | undefined;
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("Credits cannot be negative or invalid");
    }
    const [changed] = await tx.update(userTable).set(values).where(eq(userTable.id, id)).returning();
    if (updates.creditBalance !== undefined && updates.creditBalance !== target.creditBalance) {
      const difference = updates.creditBalance - target.creditBalance;
      await tx.insert(creditEventsTable).values({
        userId: id, requestId, source: "admin", type: "admin_adjustment", description: "Administrator adjusted balance",
        creditsAdded: Math.max(0, difference), creditsConsumed: Math.abs(Math.min(0, difference)),
      });
    }
    if (updates.enabled === false) await tx.delete(sessionTable).where(eq(sessionTable.userId, id));
    await audit(tx, principal, "user.updated", id, requestId, { fields: Object.keys(values).filter((field) => field !== "updatedAt") });
    return changed!;
  });
}

export async function setUserGroups(id: string, groupIds: string[], principal: ManagementPrincipal, requestId: string) {
  const selected = [...new Set(groupIds)];
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, id)).limit(1).for("update");
    if (!user) return false;
    if (selected.length) {
      const existingGroups = await tx.select({ id: groupsTable.id }).from(groupsTable).where(inArray(groupsTable.id, selected));
      if (existingGroups.length !== selected.length) throw new Error("One or more selected groups do not exist");
    }
    const current = await tx.select({ groupId: groupMembersTable.groupId, source: groupMembersTable.source }).from(groupMembersTable).where(eq(groupMembersTable.userId, id));
    const allCurrentIds = new Set(current.map((membership) => membership.groupId));
    const manualIds = new Set(current.filter((membership) => membership.source === "manual").map((membership) => membership.groupId));
    for (const groupId of manualIds) if (!selected.includes(groupId)) {
      await tx.delete(groupMembersTable).where(and(eq(groupMembersTable.userId, id), eq(groupMembersTable.groupId, groupId), eq(groupMembersTable.source, "manual")));
    }
    const additions = selected.filter((groupId) => !allCurrentIds.has(groupId));
    if (additions.length) await tx.insert(groupMembersTable).values(additions.map((groupId) => ({ groupId, userId: id, role: "member", source: "manual" })));
    await audit(tx, principal, "user.groups.updated", id, requestId, { groupIds: selected });
    return true;
  });
}

export async function bulkUpdateUsersByGroups(
  groupIds: string[],
  updates: { enabled?: boolean; apiEnabled?: boolean; defaultMonthlyCredits?: number },
  principal: ManagementPrincipal,
  requestId: string,
) {
  const selectedGroups = [...new Set(groupIds)];
  if (!selectedGroups.length) throw new Error("Select at least one group");
  const fields = Object.keys(updates).filter((key) => updates[key as keyof typeof updates] !== undefined);
  if (!fields.length) throw new Error("At least one bulk update is required");
  if (updates.defaultMonthlyCredits !== undefined && (!Number.isFinite(updates.defaultMonthlyCredits) || updates.defaultMonthlyCredits < 0)) {
    throw new Error("Credits cannot be negative or invalid");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('llm-proxy:admin-updates'))`);
    const targets = await tx.selectDistinct({ id: userTable.id, role: userTable.role, enabled: userTable.enabled })
      .from(groupMembersTable).innerJoin(userTable, eq(groupMembersTable.userId, userTable.id))
      .where(inArray(groupMembersTable.groupId, selectedGroups));
    if (!targets.length) {
      await audit(tx, principal, "group.users.bulk_updated", "bulk", requestId, { groupIds: selectedGroups, fields, usersUpdated: 0 });
      return 0;
    }
    if (updates.enabled === false) {
      const targetedEnabledAdmins = targets.filter((user) => user.role === "admin" && user.enabled).length;
      if (targetedEnabledAdmins) {
        const [allEnabledAdmins] = await tx.select({ value: count() }).from(userTable).where(and(eq(userTable.role, "admin"), eq(userTable.enabled, true)));
        if (targetedEnabledAdmins >= (allEnabledAdmins?.value ?? 0)) throw new Error("Cannot disable the final enabled administrator");
      }
    }
    const targetIds = targets.map((user) => user.id);
    await tx.update(userTable).set({ ...updates, updatedAt: new Date() }).where(inArray(userTable.id, targetIds));
    if (updates.enabled === false) await tx.delete(sessionTable).where(inArray(sessionTable.userId, targetIds));
    await audit(tx, principal, "group.users.bulk_updated", "bulk", requestId, { groupIds: selectedGroups, fields, usersUpdated: targetIds.length });
    return targetIds.length;
  });
}

export async function setUserPassword(id: string, password: string, mustChangePassword: boolean, principal: ManagementPrincipal, requestId: string) {
  validateLocalAccount({ username: "valid_user", email: "valid@example.com", name: "Valid", password });
  const passwordHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [target] = await tx.select({ id: userTable.id, role: userTable.role, enabled: userTable.enabled }).from(userTable).where(eq(userTable.id, id)).limit(1).for("update");
    if (!target) return false;
    const [credential] = await tx.select({ id: accountTable.id }).from(accountTable).where(and(eq(accountTable.userId, id), eq(accountTable.providerId, "credential"))).limit(1);
    if (credential) await tx.update(accountTable).set({ password: passwordHash, updatedAt: new Date() }).where(eq(accountTable.id, credential.id));
    else await tx.insert(accountTable).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id, password: passwordHash, createdAt: new Date(), updatedAt: new Date() });
    await tx.update(userTable).set({ mustChangePassword, updatedAt: new Date() }).where(eq(userTable.id, id));
    await tx.delete(sessionTable).where(eq(sessionTable.userId, id));
    await audit(tx, principal, "user.password.changed", id, requestId, { mustChangePassword });
    return true;
  });
}

export async function deleteUser(id: string, principal: ManagementPrincipal, requestId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('llm-proxy:admin-updates'))`);
    const [target] = await tx.select().from(userTable).where(eq(userTable.id, id)).limit(1).for("update");
    if (!target) return false;
    if (target.role === "admin" && target.enabled) {
      const [other] = await tx.select({ value: count() }).from(userTable).where(and(eq(userTable.role, "admin"), eq(userTable.enabled, true), ne(userTable.id, id)));
      if ((other?.value ?? 0) === 0) throw new Error("Cannot delete the final enabled administrator");
    }
    await audit(tx, principal, "user.deleted", id, requestId, { username: target.username });
    await tx.delete(userTable).where(eq(userTable.id, id));
    return true;
  });
}
