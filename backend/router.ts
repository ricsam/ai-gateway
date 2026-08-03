import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { createRouter, Status } from "@richie-rpc/server";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import db from "@/db";
import { contract } from "@/shared/contract";
import { requireAdmin } from "./admin-guard";
import { authenticateRequest, updateUserAccessSafely } from "./auth";
import { addCredits, calculateCost } from "./credit-service";
import { hashApiKey } from "./api-key-utils";
import resetCredits from "./jobs/reset-credits";
import { getBedrockClient } from "./bedrock";
import {
  apiKeysTable,
  creditEventsTable,
  modelsTable,
  teamMembersTable,
  teamsTable,
  userTable,
} from "./schema";

interface RouterContext { getUserId: () => string }
const teamRoleValues = new Set(["owner", "admin", "member"]);

function modelResponse(model: typeof modelsTable.$inferSelect) {
  return {
    id: model.id,
    modelId: model.modelId,
    name: model.name,
    description: model.description,
    provider: model.provider,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok,
    cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok,
    cacheReadPricePerMTok: model.cacheReadPricePerMTok,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    thinking: model.thinking,
    managedCache: model.managedCache,
    region: model.region,
    enabled: model.enabled,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

export const router = createRouter<typeof contract, RouterContext>(contract, {
  getProfile: async ({ context }) => {
    const [user] = await db.select().from(userTable).where(eq(userTable.id, context.getUserId())).limit(1);
    if (!user) return { status: Status.Unauthorized, body: { error: "User not found" } };
    return { status: Status.OK, body: {
      id: user.id, name: user.name, email: user.email, creditBalance: user.creditBalance,
      defaultMonthlyCredits: user.defaultMonthlyCredits, role: user.role as "user" | "admin", apiEnabled: user.apiEnabled,
    } };
  },

  getModels: async () => {
    const models = await db.select().from(modelsTable).where(eq(modelsTable.enabled, true)).orderBy(asc(modelsTable.name));
    return { status: Status.OK, body: models.map((model) => ({
      modelId: model.modelId, displayName: model.name, thinking: model.thinking, provider: model.provider,
      maxTokens: model.contextWindow ?? undefined, maxOutputTokens: model.maxOutputTokens,
      inputPricePerMTok: model.inputPricePerMTok, outputPricePerMTok: model.outputPricePerMTok,
      cacheReadPricePerMTok: model.cacheReadPricePerMTok ?? undefined,
      cacheWrite5mPricePerMTok: model.cacheWrite5mPricePerMTok ?? undefined,
      cacheWrite1hPricePerMTok: model.cacheWrite1hPricePerMTok ?? undefined,
    })) };
  },

  getUserUsageLogs: async ({ query, context }) => {
    const userId = context.getUserId();
    const limit = Math.min(Math.max(Number(query.limit ?? 20), 1), 100);
    const offset = Math.max(Number(query.offset ?? 0), 0);
    const [events, totalRows] = await Promise.all([
      db.select().from(creditEventsTable).where(eq(creditEventsTable.userId, userId))
        .orderBy(desc(creditEventsTable.time)).limit(limit).offset(offset),
      db.select({ count: count() }).from(creditEventsTable).where(eq(creditEventsTable.userId, userId)),
    ]);
    const running = await db.executeRaw<{ id: string; balance_after: string }>(`
      SELECT id, SUM(credits_added - credits_consumed) OVER (PARTITION BY user_id ORDER BY time, id) AS balance_after
      FROM credit_events WHERE user_id = $1
    `, [userId]);
    const balances = new Map(running.rows.map((row) => [row.id, Number(row.balance_after)]));
    return { status: Status.OK, body: {
      logs: events.map((event) => ({
        id: event.id, creditsAdded: event.creditsAdded, creditsConsumed: event.creditsConsumed,
        balanceAfter: balances.get(event.id) ?? 0, type: event.type, source: event.source,
        description: event.description, model: event.model, inputTokens: event.inputTokens,
        outputTokens: event.outputTokens, cacheReadTokens: event.cacheReadTokens,
        cacheWrite5mTokens: event.cacheWrite5mTokens, cacheWrite1hTokens: event.cacheWrite1hTokens,
        inputCost: event.inputCost, outputCost: event.outputCost, cacheReadCost: event.cacheReadCost,
        cacheWrite5mCost: event.cacheWrite5mCost, cacheWrite1hCost: event.cacheWrite1hCost,
        time: event.time.toISOString(),
      })),
      total: totalRows[0]?.count ?? 0,
    } };
  },

  listApiKeys: async ({ context }) => {
    const keys = await db.select().from(apiKeysTable).where(and(
      eq(apiKeysTable.userId, context.getUserId()), eq(apiKeysTable.enabled, true),
    )).orderBy(desc(apiKeysTable.createdAt));
    return { status: Status.OK, body: keys.map((key) => ({
      id: key.id, name: key.name, keyPrefix: key.keyPrefix, scopes: key.scopes,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null, expiresAt: key.expiresAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    })) };
  },

  createApiKey: async ({ body, context }) => {
    const scopes = body.scopes ?? ["llm.invoke", "models.read", "credits.read"];
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) return { status: Status.BadRequest, body: { error: "Expiry must be in the future" } };
    const rawKey = `llmp_${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    const keyHash = await hashApiKey(rawKey);
    const [key] = await db.insert(apiKeysTable).values({
      userId: context.getUserId(), name: body.name, keyHash, keyPrefix: rawKey.slice(0, 13), scopes, expiresAt,
    }).returning();
    return { status: Status.Created, body: {
      id: key!.id, name: key!.name, keyPrefix: key!.keyPrefix, key: rawKey, scopes: key!.scopes,
      expiresAt: key!.expiresAt?.toISOString() ?? null, createdAt: key!.createdAt.toISOString(),
    } };
  },

  deleteApiKey: async ({ params, context }) => {
    const [key] = await db.select({ id: apiKeysTable.id }).from(apiKeysTable).where(and(
      eq(apiKeysTable.id, params.id), eq(apiKeysTable.userId, context.getUserId()),
    )).limit(1);
    if (!key) return { status: Status.NotFound, body: { error: "API key not found" } };
    await db.update(apiKeysTable).set({ enabled: false, revokedAt: new Date() }).where(eq(apiKeysTable.id, key.id));
    return { status: Status.OK, body: { success: true } };
  },

  adminListModels: async ({ request }) => {
    await requireAdmin(request);
    const models = await db.select().from(modelsTable).orderBy(asc(modelsTable.name));
    return { status: Status.OK, body: models.map(modelResponse) };
  },

  adminCreateModel: async ({ body, request }) => {
    await requireAdmin(request);
    const [model] = await db.insert(modelsTable).values(body).returning();
    return { status: Status.Created, body: modelResponse(model!) };
  },

  adminUpdateModel: async ({ params, body, request }) => {
    await requireAdmin(request);
    const [model] = await db.update(modelsTable).set({ ...body, updatedAt: new Date() })
      .where(eq(modelsTable.id, params.id)).returning();
    if (!model) return { status: Status.NotFound, body: { error: "Model not found" } };
    return { status: Status.OK, body: modelResponse(model) };
  },

  adminDeleteModel: async ({ params, request }) => {
    await requireAdmin(request);
    const removed = await db.delete(modelsTable).where(eq(modelsTable.id, params.id)).returning({ id: modelsTable.id });
    if (!removed.length) return { status: Status.NotFound, body: { error: "Model not found" } };
    return { status: Status.OK, body: { success: true } };
  },

  adminTestModel: async ({ body, request }) => {
    await requireAdmin(request);
    try {
      const client: BedrockRuntimeClient = getBedrockClient(body.region);
      const response = await client.send(new ConverseCommand({
        modelId: body.modelId,
        messages: [{ role: "user", content: [{ text: body.prompt }] }],
        inferenceConfig: { maxTokens: 256 },
      }));
      const inputTokens = response.usage?.inputTokens ?? 0;
      const outputTokens = response.usage?.outputTokens ?? 0;
      const text = response.output?.message?.content?.map((part) => part.text ?? "").join("") ?? "";
      return { status: Status.OK, body: {
        success: true, response: text, inputTokens, outputTokens,
        cost: calculateCost(inputTokens, outputTokens, body.inputPricePerMTok, body.outputPricePerMTok),
      } };
    } catch (error) {
      return { status: Status.BadRequest, body: { error: error instanceof Error ? error.message : "Model test failed" } };
    }
  },

  adminListUsers: async ({ request }) => {
    await requireAdmin(request);
    const users = await db.select().from(userTable).orderBy(asc(userTable.email));
    const memberships = await db.select({
      userId: teamMembersTable.userId, teamId: teamsTable.id, teamName: teamsTable.name, role: teamMembersTable.role,
    }).from(teamMembersTable).innerJoin(teamsTable, eq(teamMembersTable.teamId, teamsTable.id));
    return { status: Status.OK, body: users.map((user) => ({
      id: user.id, name: user.name, email: user.email, role: user.role as "user" | "admin",
      creditBalance: user.creditBalance, defaultMonthlyCredits: user.defaultMonthlyCredits,
      enabled: user.enabled, apiEnabled: user.apiEnabled, createdAt: user.createdAt.toISOString(),
      teams: memberships.filter((entry) => entry.userId === user.id).map((entry) => ({
        id: entry.teamId, name: entry.teamName, role: entry.role as "owner" | "admin" | "member",
      })),
    })) };
  },

  adminUpdateUserCredits: async ({ params, body, request }) => {
    await requireAdmin(request);
    const [user] = await db.select().from(userTable).where(eq(userTable.id, params.id)).limit(1);
    if (!user) return { status: Status.NotFound, body: { error: "User not found" } };
    if (body.defaultMonthlyCredits !== undefined) {
      await db.update(userTable).set({ defaultMonthlyCredits: body.defaultMonthlyCredits }).where(eq(userTable.id, params.id));
    }
    if (body.creditBalance !== undefined && body.creditBalance !== user.creditBalance) {
      await addCredits({ userId: user.id, amount: body.creditBalance - user.creditBalance, type: "admin_adjustment", description: "Administrator adjusted balance" });
    }
    return { status: Status.OK, body: { success: true } };
  },

  adminUpdateUser: async ({ params, body, request }) => {
    await requireAdmin(request);
    try {
      const updated = await updateUserAccessSafely(params.id, body);
      if (!updated) return { status: Status.NotFound, body: { error: "User not found" } };
    } catch (error) {
      return { status: Status.BadRequest, body: { error: error instanceof Error ? error.message : "Unsafe administrator update" } };
    }
    return { status: Status.OK, body: { success: true } };
  },

  adminRunMonthlyReset: async ({ request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await resetCredits() }; }
    catch (error) { return { status: Status.BadRequest, body: { error: error instanceof Error ? error.message : "Reset failed" } }; }
  },

  adminListTeams: async ({ request }) => {
    await requireAdmin(request);
    const teams = await db.select({
      id: teamsTable.id, name: teamsTable.name, description: teamsTable.description, createdAt: teamsTable.createdAt,
      memberCount: sql<number>`count(${teamMembersTable.userId})::int`,
    }).from(teamsTable).leftJoin(teamMembersTable, eq(teamMembersTable.teamId, teamsTable.id))
      .groupBy(teamsTable.id).orderBy(asc(teamsTable.name));
    return { status: Status.OK, body: teams.map((team) => ({ ...team, createdAt: team.createdAt.toISOString() })) };
  },

  adminCreateTeam: async ({ body, request }) => {
    await requireAdmin(request);
    const [team] = await db.insert(teamsTable).values(body).returning();
    return { status: Status.Created, body: { id: team!.id, name: team!.name, description: team!.description, createdAt: team!.createdAt.toISOString() } };
  },

  adminDeleteTeam: async ({ params, request }) => {
    await requireAdmin(request);
    const removed = await db.delete(teamsTable).where(eq(teamsTable.id, params.id)).returning({ id: teamsTable.id });
    if (!removed.length) return { status: Status.NotFound, body: { error: "Team not found" } };
    return { status: Status.OK, body: { success: true } };
  },

  adminGetTeam: async ({ params, request }) => {
    await requireAdmin(request);
    const [team] = await db.select().from(teamsTable).where(eq(teamsTable.id, params.id)).limit(1);
    if (!team) return { status: Status.NotFound, body: { error: "Team not found" } };
    const members = await db.select({
      userId: userTable.id, name: userTable.name, email: userTable.email, role: teamMembersTable.role, joinedAt: teamMembersTable.joinedAt,
    }).from(teamMembersTable).innerJoin(userTable, eq(teamMembersTable.userId, userTable.id))
      .where(eq(teamMembersTable.teamId, team.id));
    return { status: Status.OK, body: {
      id: team.id, name: team.name, description: team.description, createdAt: team.createdAt.toISOString(),
      members: members.map((member) => ({ ...member, role: member.role as "owner" | "admin" | "member", joinedAt: member.joinedAt.toISOString() })),
    } };
  },

  adminAddTeamMember: async ({ params, body, request }) => {
    await requireAdmin(request);
    if (!teamRoleValues.has(body.role)) return { status: Status.BadRequest, body: { error: "Invalid team role" } };
    try {
      await db.insert(teamMembersTable).values({ teamId: params.id, userId: body.userId, role: body.role });
      return { status: Status.Created, body: { success: true } };
    } catch { return { status: Status.BadRequest, body: { error: "Could not add team member" } }; }
  },

  adminUpdateTeamMember: async ({ params, body, request }) => {
    await requireAdmin(request);
    const changed = await db.update(teamMembersTable).set({ role: body.role }).where(and(
      eq(teamMembersTable.teamId, params.id), eq(teamMembersTable.userId, params.userId),
    )).returning({ userId: teamMembersTable.userId });
    if (!changed.length) return { status: Status.NotFound, body: { error: "Membership not found" } };
    return { status: Status.OK, body: { success: true } };
  },

  adminRemoveTeamMember: async ({ params, request }) => {
    await requireAdmin(request);
    const removed = await db.delete(teamMembersTable).where(and(
      eq(teamMembersTable.teamId, params.id), eq(teamMembersTable.userId, params.userId),
    )).returning({ userId: teamMembersTable.userId });
    if (!removed.length) return { status: Status.NotFound, body: { error: "Membership not found" } };
    return { status: Status.OK, body: { success: true } };
  },
}, {
  basePath: "/api/router",
  async context(request) {
    const current = await authenticateRequest(request);
    return { getUserId() { if (!current) throw new UnauthorizedError(); return current.userId; } };
  },
});

export class UnauthorizedError extends Error { constructor() { super("Unauthorized"); } }
