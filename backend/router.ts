import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { createRouter, Status } from "@richie-rpc/server";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import db from "@/db";
import { contract } from "@/shared/contract";
import { requireAdmin } from "./admin-guard";
import { authenticateRequest } from "./auth";
import { updateUser } from "./user-service";
import type { ManagementPrincipal } from "./management-auth";
import { addCredits, calculateCost } from "./credit-service";
import { hashApiKey } from "./api-key-utils";
import resetCredits from "./jobs/reset-credits";
import { getBedrockClient } from "./bedrock";
import {
  getBalanceBurndown,
  getCreditsConsumed,
  getGroupSummary,
  getGroupUserBurndowns,
  getModelSummary,
  getTokensConsumed,
  getUsageByModel,
  getUserSummary,
  type AnalyticsScope,
} from "./analytics-service";
import {
  apiKeysTable,
  auditEventsTable,
  creditEventsTable,
  modelsTable,
  groupMembersTable,
  groupsTable,
  userTable,
} from "./schema";

interface RouterContext { getUserId: () => string }
const groupRoleValues = new Set(["owner", "admin", "member"]);
function adminPrincipal(userId: string): ManagementPrincipal { return { actorType: "user", actorId: userId, userId, scopes: new Set(["*"]) }; }

async function usageLogs(userId: string, rawLimit?: string, rawOffset?: string) {
  const limit = Math.min(Math.max(Number(rawLimit ?? 20), 1), 100);
  const offset = Math.max(Number(rawOffset ?? 0), 0);
  const [events, totalRows, running] = await Promise.all([
    db.select().from(creditEventsTable).where(eq(creditEventsTable.userId, userId))
      .orderBy(desc(creditEventsTable.time), desc(creditEventsTable.id)).limit(limit).offset(offset),
    db.select({ count: count() }).from(creditEventsTable).where(eq(creditEventsTable.userId, userId)),
    db.executeRaw<{ id: string; balance_after: string }>(`
      SELECT id, SUM(credits_added - credits_consumed) OVER (PARTITION BY user_id ORDER BY time, id) AS balance_after
      FROM credit_events WHERE user_id = $1
    `, [userId]),
  ]);
  const balances = new Map(running.rows.map((row) => [row.id, Number(row.balance_after)]));
  return {
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
  };
}

function analyticsScope(scope: "system" | "user" | "group", scopeId?: string): AnalyticsScope {
  if (scope === "system") return {};
  if (!scopeId) throw new Error(`scopeId is required for ${scope} analytics`);
  return scope === "user" ? { userId: scopeId } : { groupId: scopeId };
}

function analyticsFailure(error: unknown) {
  return { status: Status.BadRequest, body: { error: error instanceof Error ? error.message : "Analytics query failed" } };
}

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

  getUserUsageLogs: async ({ query, context }) => ({
    status: Status.OK,
    body: await usageLogs(context.getUserId(), query.limit, query.offset),
  }),

  getAnalyticsBurndown: async ({ query, context }) => {
    try { return { status: Status.OK, body: await getBalanceBurndown(query.timeRange, query.bucketSize, { userId: context.getUserId() }) }; }
    catch (error) { return analyticsFailure(error); }
  },
  getAnalyticsConsumed: async ({ query, context }) => {
    try { return { status: Status.OK, body: { data: await getCreditsConsumed(query.timeRange, query.bucketSize, { userId: context.getUserId() }) } }; }
    catch (error) { return analyticsFailure(error); }
  },
  getAnalyticsByModel: async ({ query, context }) => {
    try { return { status: Status.OK, body: await getUsageByModel(query.timeRange, query.bucketSize, { userId: context.getUserId() }, Number(query.topN ?? 5)) }; }
    catch (error) { return analyticsFailure(error); }
  },
  getAnalyticsModelSummary: async ({ query, context }) => {
    try { return { status: Status.OK, body: await getModelSummary(query.timeRange, query.bucketSize, { userId: context.getUserId() }) }; }
    catch (error) { return analyticsFailure(error); }
  },
  getAnalyticsTokensConsumed: async ({ query, context }) => {
    try { return { status: Status.OK, body: await getTokensConsumed(query.timeRange, query.bucketSize, { userId: context.getUserId() }) }; }
    catch (error) { return analyticsFailure(error); }
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
    const scopes = body.scopes ?? ["ai.invoke", "models.read", "credits.read"];
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) return { status: Status.BadRequest, body: { error: "Expiry must be in the future" } };
    const rawKey = `aig_${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
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
    const actor = await requireAdmin(request); const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const [model] = await db.transaction(async (tx) => {
      const created = await tx.insert(modelsTable).values(body).returning();
      await tx.insert(auditEventsTable).values({ actorType: "user", actorId: actor.id, action: "model.created", targetType: "model", targetId: created[0]!.id, requestId, metadata: { modelId: created[0]!.modelId } });
      return created;
    });
    return { status: Status.Created, body: modelResponse(model!) };
  },

  adminUpdateModel: async ({ params, body, request }) => {
    const actor = await requireAdmin(request); const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const model = await db.transaction(async (tx) => {
      const [changed] = await tx.update(modelsTable).set({ ...body, updatedAt: new Date() }).where(eq(modelsTable.id, params.id)).returning();
      if (changed) await tx.insert(auditEventsTable).values({ actorType: "user", actorId: actor.id, action: "model.updated", targetType: "model", targetId: changed.id, requestId, metadata: { fields: Object.keys(body) } });
      return changed;
    });
    if (!model) return { status: Status.NotFound, body: { error: "Model not found" } };
    return { status: Status.OK, body: modelResponse(model) };
  },

  adminDeleteModel: async ({ params, request }) => {
    const actor = await requireAdmin(request); const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const removed = await db.transaction(async (tx) => {
      const rows = await tx.delete(modelsTable).where(eq(modelsTable.id, params.id)).returning({ id: modelsTable.id, modelId: modelsTable.modelId });
      if (rows[0]) await tx.insert(auditEventsTable).values({ actorType: "user", actorId: actor.id, action: "model.deleted", targetType: "model", targetId: rows[0].id, requestId, metadata: { modelId: rows[0].modelId } });
      return rows;
    });
    if (!removed.length) return { status: Status.NotFound, body: { error: "Model not found" } };
    return { status: Status.OK, body: { success: true } };
  },

  adminTestModel: async ({ body, request }) => {
    await requireAdmin(request);
    try {
      const client: BedrockRuntimeClient = await getBedrockClient(body.region);
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
      userId: groupMembersTable.userId, groupId: groupsTable.id, groupName: groupsTable.name, role: groupMembersTable.role,
    }).from(groupMembersTable).innerJoin(groupsTable, eq(groupMembersTable.groupId, groupsTable.id));
    return { status: Status.OK, body: users.map((user) => ({
      id: user.id, name: user.name, email: user.email, role: user.role as "user" | "admin",
      creditBalance: user.creditBalance, defaultMonthlyCredits: user.defaultMonthlyCredits,
      enabled: user.enabled, apiEnabled: user.apiEnabled, createdAt: user.createdAt.toISOString(),
      groups: memberships.filter((entry) => entry.userId === user.id).map((entry) => ({
        id: entry.groupId, name: entry.groupName, role: entry.role as "owner" | "admin" | "member",
      })),
    })) };
  },

  adminGetUserUsageLogs: async ({ params, query, request }) => {
    await requireAdmin(request);
    const [user] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, params.id)).limit(1);
    if (!user) return { status: Status.NotFound, body: { error: "User not found" } };
    return { status: Status.OK, body: await usageLogs(params.id, query.limit, query.offset) };
  },

  adminGetAnalyticsBurndown: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getBalanceBurndown(query.timeRange, query.bucketSize, analyticsScope(query.scope, query.scopeId)) }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetAnalyticsConsumed: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: { data: await getCreditsConsumed(query.timeRange, query.bucketSize, analyticsScope(query.scope, query.scopeId)) } }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetAnalyticsByModel: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getUsageByModel(query.timeRange, query.bucketSize, analyticsScope(query.scope, query.scopeId), Number(query.topN ?? 5)) }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetAnalyticsModelSummary: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getModelSummary(query.timeRange, query.bucketSize, analyticsScope(query.scope, query.scopeId)) }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetAnalyticsTokensConsumed: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getTokensConsumed(query.timeRange, query.bucketSize, analyticsScope(query.scope, query.scopeId)) }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetAnalyticsUserSummary: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getUserSummary(query.timeRange, query.groupId) }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetAnalyticsGroupSummary: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getGroupSummary(query.timeRange) }; }
    catch (error) { return analyticsFailure(error); }
  },
  adminGetGroupUserBurndowns: async ({ query, request }) => {
    try { await requireAdmin(request); return { status: Status.OK, body: await getGroupUserBurndowns(query.timeRange, query.bucketSize, query.groupId) }; }
    catch (error) { return analyticsFailure(error); }
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
      const actor = await requireAdmin(request);
      const updated = await updateUser(params.id, body, adminPrincipal(actor.id), request.headers.get("x-request-id") || crypto.randomUUID());
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

  adminListGroups: async ({ request }) => {
    await requireAdmin(request);
    const groups = await db.select({
      id: groupsTable.id, name: groupsTable.name, description: groupsTable.description, createdAt: groupsTable.createdAt,
      memberCount: sql<number>`count(${groupMembersTable.userId})::int`,
    }).from(groupsTable).leftJoin(groupMembersTable, eq(groupMembersTable.groupId, groupsTable.id))
      .groupBy(groupsTable.id).orderBy(asc(groupsTable.name));
    return { status: Status.OK, body: groups.map((group) => ({ ...group, createdAt: group.createdAt.toISOString() })) };
  },

  adminCreateGroup: async ({ body, request }) => {
    await requireAdmin(request);
    const [group] = await db.insert(groupsTable).values(body).returning();
    return { status: Status.Created, body: { id: group!.id, name: group!.name, description: group!.description, createdAt: group!.createdAt.toISOString() } };
  },

  adminDeleteGroup: async ({ params, request }) => {
    await requireAdmin(request);
    const removed = await db.delete(groupsTable).where(eq(groupsTable.id, params.id)).returning({ id: groupsTable.id });
    if (!removed.length) return { status: Status.NotFound, body: { error: "Group not found" } };
    return { status: Status.OK, body: { success: true } };
  },

  adminGetGroup: async ({ params, request }) => {
    await requireAdmin(request);
    const [group] = await db.select().from(groupsTable).where(eq(groupsTable.id, params.id)).limit(1);
    if (!group) return { status: Status.NotFound, body: { error: "Group not found" } };
    const members = await db.select({
      userId: userTable.id, name: userTable.name, email: userTable.email, role: groupMembersTable.role, joinedAt: groupMembersTable.joinedAt,
    }).from(groupMembersTable).innerJoin(userTable, eq(groupMembersTable.userId, userTable.id))
      .where(eq(groupMembersTable.groupId, group.id));
    return { status: Status.OK, body: {
      id: group.id, name: group.name, description: group.description, createdAt: group.createdAt.toISOString(),
      members: members.map((member) => ({ ...member, role: member.role as "owner" | "admin" | "member", joinedAt: member.joinedAt.toISOString() })),
    } };
  },

  adminAddGroupMember: async ({ params, body, request }) => {
    await requireAdmin(request);
    if (!groupRoleValues.has(body.role)) return { status: Status.BadRequest, body: { error: "Invalid group role" } };
    try {
      await db.insert(groupMembersTable).values({ groupId: params.id, userId: body.userId, role: body.role });
      return { status: Status.Created, body: { success: true } };
    } catch { return { status: Status.BadRequest, body: { error: "Could not add group member" } }; }
  },

  adminUpdateGroupMember: async ({ params, body, request }) => {
    await requireAdmin(request);
    const changed = await db.update(groupMembersTable).set({ role: body.role }).where(and(
      eq(groupMembersTable.groupId, params.id), eq(groupMembersTable.userId, params.userId),
    )).returning({ userId: groupMembersTable.userId });
    if (!changed.length) return { status: Status.NotFound, body: { error: "Membership not found" } };
    return { status: Status.OK, body: { success: true } };
  },

  adminRemoveGroupMember: async ({ params, request }) => {
    await requireAdmin(request);
    const removed = await db.delete(groupMembersTable).where(and(
      eq(groupMembersTable.groupId, params.id), eq(groupMembersTable.userId, params.userId),
    )).returning({ userId: groupMembersTable.userId });
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
