import { defineContract, Status } from "@richie-rpc/core";
import { z } from "zod";

const modelSchema = z.object({
  id: z.string(),
  modelId: z.string(),
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().nullable(),
  provider: z.string(),
  inputPricePerMTok: z.number(),
  outputPricePerMTok: z.number(),
  cacheWrite5mPricePerMTok: z.number().nullable(),
  cacheWrite1hPricePerMTok: z.number().nullable(),
  cacheReadPricePerMTok: z.number().nullable(),
  contextWindow: z.number().nullable(),
  maxOutputTokens: z.number(),
  thinking: z.boolean(),
  managedCache: z.boolean(),
  region: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const groupSummarySchema = z.object({ id: z.string(), name: z.string(), role: z.enum(["owner", "admin", "member"]) });
const timeRangeSchema = z.enum(["hour", "day", "week", "month", "quarter", "year"]);
const bucketSizeSchema = z.enum(["15s", "1m", "5m", "30m", "1h", "1d", "1w", "1mo"]);
const analyticsQuerySchema = z.object({ timeRange: timeRangeSchema, bucketSize: bucketSizeSchema.optional() });
const adminAnalyticsQuerySchema = analyticsQuerySchema.extend({
  scope: z.enum(["system", "user", "group"]),
  scopeId: z.string().optional(),
});
const modelSummarySchema = z.object({
  model: z.string(), totalCredits: z.number(), inputTokens: z.number(), outputTokens: z.number(),
  cacheReadTokens: z.number(), cacheWrite5mTokens: z.number(), cacheWrite1hTokens: z.number(), percentOfTotal: z.number(),
});
const tokensConsumedSchema = z.object({
  inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number(),
  cacheWrite5mTokens: z.number(), cacheWrite1hTokens: z.number(), total: z.number(),
});
const userAnalyticsSummarySchema = z.object({
  userId: z.string(), username: z.string(), creditsUsed: z.number(), activeDays: z.number(),
  avgCreditsPerDay: z.number(), lastActivity: z.string().nullable(), percentOfTotal: z.number(),
});

const usageLogSchema = z.object({
  id: z.string(),
  creditsAdded: z.number(),
  creditsConsumed: z.number(),
  balanceAfter: z.number(),
  type: z.string(),
  source: z.string(),
  description: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWrite5mTokens: z.number(),
  cacheWrite1hTokens: z.number(),
  inputCost: z.number(),
  outputCost: z.number(),
  cacheReadCost: z.number(),
  cacheWrite5mCost: z.number(),
  cacheWrite1hCost: z.number(),
  time: z.string(),
});

export const contract = defineContract({
  getProfile: {
    type: "standard", method: "GET", path: "/profile",
    responses: { [Status.OK]: z.object({
      id: z.string(), name: z.string(), email: z.string(), creditBalance: z.number(),
      defaultMonthlyCredits: z.number(), role: z.enum(["user", "admin"]), apiEnabled: z.boolean(),
    }) },
    errorResponses: { [Status.Unauthorized]: z.object({ error: z.string() }) },
  },
  getModels: {
    type: "standard", method: "GET", path: "/models",
    responses: { [Status.OK]: z.array(z.object({
      modelId: z.string(), displayName: z.string(), thinking: z.boolean(), provider: z.string(),
      maxTokens: z.number().optional(), maxOutputTokens: z.number(), inputPricePerMTok: z.number(),
      outputPricePerMTok: z.number(), cacheReadPricePerMTok: z.number().optional(),
      cacheWrite5mPricePerMTok: z.number().optional(), cacheWrite1hPricePerMTok: z.number().optional(),
    })) },
  },
  getUserUsageLogs: {
    type: "standard", method: "GET", path: "/usage",
    query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
    responses: { [Status.OK]: z.object({ logs: z.array(usageLogSchema), total: z.number() }) },
  },
  getAnalyticsBurndown: {
    type: "standard", method: "GET", path: "/analytics/burndown", query: analyticsQuerySchema,
    responses: { [Status.OK]: z.object({ data: z.array(z.object({ time: z.string(), balance: z.number() })), currentBalance: z.number() }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  getAnalyticsConsumed: {
    type: "standard", method: "GET", path: "/analytics/consumed", query: analyticsQuerySchema,
    responses: { [Status.OK]: z.object({ data: z.array(z.object({ time: z.string(), consumed: z.number() })) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  getAnalyticsByModel: {
    type: "standard", method: "GET", path: "/analytics/by-model", query: analyticsQuerySchema.extend({ topN: z.string().optional() }),
    responses: { [Status.OK]: z.object({ data: z.array(z.object({ time: z.string(), model: z.string(), consumed: z.number() })), models: z.array(z.string()) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  getAnalyticsModelSummary: {
    type: "standard", method: "GET", path: "/analytics/model-summary", query: analyticsQuerySchema,
    responses: { [Status.OK]: z.object({ models: z.array(modelSummarySchema) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  getAnalyticsTokensConsumed: {
    type: "standard", method: "GET", path: "/analytics/tokens-consumed", query: analyticsQuerySchema,
    responses: { [Status.OK]: z.object({ data: z.array(tokensConsumedSchema.extend({ time: z.string() })), summary: tokensConsumedSchema }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  listApiKeys: {
    type: "standard", method: "GET", path: "/api-keys",
    responses: { [Status.OK]: z.array(z.object({
      id: z.string(), name: z.string(), keyPrefix: z.string(), scopes: z.array(z.string()),
      lastUsedAt: z.string().nullable(), expiresAt: z.string().nullable(), createdAt: z.string(),
    })) },
  },
  createApiKey: {
    type: "standard", method: "POST", path: "/api-keys",
    body: z.object({
      name: z.string().min(1).max(100),
      scopes: z.array(z.enum(["llm.invoke", "models.read", "credits.read"])).min(1).optional(),
      expiresAt: z.string().datetime().optional(),
    }),
    responses: { [Status.Created]: z.object({
      id: z.string(), name: z.string(), keyPrefix: z.string(), key: z.string(), scopes: z.array(z.string()),
      expiresAt: z.string().nullable(), createdAt: z.string(),
    }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  deleteApiKey: {
    type: "standard", method: "DELETE", path: "/api-keys/:id",
    params: z.object({ id: z.string() }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminListModels: {
    type: "standard", method: "GET", path: "/admin/models",
    responses: { [Status.OK]: z.array(modelSchema) },
  },
  adminCreateModel: {
    type: "standard", method: "POST", path: "/admin/models",
    body: z.object({
      modelId: z.string().min(1), name: z.string().min(1), description: z.string().optional(),
      inputPricePerMTok: z.number().nonnegative(), outputPricePerMTok: z.number().nonnegative(),
      cacheWrite5mPricePerMTok: z.number().nonnegative().optional(), cacheWrite1hPricePerMTok: z.number().nonnegative().optional(),
      cacheReadPricePerMTok: z.number().nonnegative().optional(), contextWindow: z.number().positive().optional(),
      maxOutputTokens: z.number().positive().optional(), thinking: z.boolean().optional(), managedCache: z.boolean().optional(),
      enabled: z.boolean().optional(), region: z.string().optional(),
    }),
    responses: { [Status.Created]: modelSchema },
  },
  adminUpdateModel: {
    type: "standard", method: "PATCH", path: "/admin/models/:id", params: z.object({ id: z.string() }),
    body: z.object({
      modelId: z.string().min(1).optional(), name: z.string().min(1).optional(), description: z.string().optional(),
      inputPricePerMTok: z.number().nonnegative().optional(), outputPricePerMTok: z.number().nonnegative().optional(),
      cacheWrite5mPricePerMTok: z.number().nonnegative().optional(), cacheWrite1hPricePerMTok: z.number().nonnegative().optional(),
      cacheReadPricePerMTok: z.number().nonnegative().optional(), contextWindow: z.number().positive().optional(),
      maxOutputTokens: z.number().positive().optional(), thinking: z.boolean().optional(), managedCache: z.boolean().optional(),
      region: z.string().optional(), enabled: z.boolean().optional(),
    }),
    responses: { [Status.OK]: modelSchema },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminDeleteModel: {
    type: "standard", method: "DELETE", path: "/admin/models/:id", params: z.object({ id: z.string() }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminTestModel: {
    type: "standard", method: "POST", path: "/admin/models/test",
    body: z.object({ modelId: z.string(), prompt: z.string(), inputPricePerMTok: z.number(), outputPricePerMTok: z.number(), region: z.string().optional() }),
    responses: { [Status.OK]: z.object({ success: z.boolean(), response: z.string(), inputTokens: z.number(), outputTokens: z.number(), cost: z.number() }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminListUsers: {
    type: "standard", method: "GET", path: "/admin/users",
    responses: { [Status.OK]: z.array(z.object({
      id: z.string(), name: z.string(), email: z.string(), role: z.enum(["user", "admin"]), creditBalance: z.number(),
      defaultMonthlyCredits: z.number(), enabled: z.boolean(), apiEnabled: z.boolean(), createdAt: z.string(),
      groups: z.array(groupSummarySchema),
    })) },
  },
  adminGetUserUsageLogs: {
    type: "standard", method: "GET", path: "/admin/users/:id/usage", params: z.object({ id: z.string() }),
    query: z.object({ limit: z.string().optional(), offset: z.string().optional() }),
    responses: { [Status.OK]: z.object({ logs: z.array(usageLogSchema), total: z.number() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsBurndown: {
    type: "standard", method: "GET", path: "/admin/analytics/burndown", query: adminAnalyticsQuerySchema,
    responses: { [Status.OK]: z.object({ data: z.array(z.object({ time: z.string(), balance: z.number() })), currentBalance: z.number() }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsConsumed: {
    type: "standard", method: "GET", path: "/admin/analytics/consumed", query: adminAnalyticsQuerySchema,
    responses: { [Status.OK]: z.object({ data: z.array(z.object({ time: z.string(), consumed: z.number() })) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsByModel: {
    type: "standard", method: "GET", path: "/admin/analytics/by-model", query: adminAnalyticsQuerySchema.extend({ topN: z.string().optional() }),
    responses: { [Status.OK]: z.object({ data: z.array(z.object({ time: z.string(), model: z.string(), consumed: z.number() })), models: z.array(z.string()) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsModelSummary: {
    type: "standard", method: "GET", path: "/admin/analytics/model-summary", query: adminAnalyticsQuerySchema,
    responses: { [Status.OK]: z.object({ models: z.array(modelSummarySchema) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsTokensConsumed: {
    type: "standard", method: "GET", path: "/admin/analytics/tokens-consumed", query: adminAnalyticsQuerySchema,
    responses: { [Status.OK]: z.object({ data: z.array(tokensConsumedSchema.extend({ time: z.string() })), summary: tokensConsumedSchema }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsUserSummary: {
    type: "standard", method: "GET", path: "/admin/analytics/user-summary",
    query: z.object({ timeRange: timeRangeSchema, groupId: z.string().optional() }),
    responses: { [Status.OK]: z.object({ users: z.array(userAnalyticsSummarySchema) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetAnalyticsGroupSummary: {
    type: "standard", method: "GET", path: "/admin/analytics/group-summary", query: z.object({ timeRange: timeRangeSchema }),
    responses: { [Status.OK]: z.object({ groups: z.array(z.object({ groupId: z.string(), groupName: z.string(), creditsUsed: z.number(), activeUsers: z.number(), avgCreditsPerUser: z.number() })) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminGetGroupUserBurndowns: {
    type: "standard", method: "GET", path: "/admin/analytics/group-user-burndowns",
    query: z.object({ timeRange: timeRangeSchema, bucketSize: bucketSizeSchema.optional(), groupId: z.string() }),
    responses: { [Status.OK]: z.object({ users: z.array(z.object({ userId: z.string(), username: z.string(), data: z.array(z.object({ time: z.string(), balance: z.number() })) })) }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminUpdateUserCredits: {
    type: "standard", method: "POST", path: "/admin/users/:id/credits", params: z.object({ id: z.string() }),
    body: z.object({ creditBalance: z.number().nonnegative().optional(), defaultMonthlyCredits: z.number().nonnegative().optional() }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminUpdateUser: {
    type: "standard", method: "PATCH", path: "/admin/users/:id", params: z.object({ id: z.string() }),
    body: z.object({ enabled: z.boolean().optional(), apiEnabled: z.boolean().optional(), role: z.enum(["user", "admin"]).optional() }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }), [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminRunMonthlyReset: {
    type: "standard", method: "POST", path: "/admin/monthly-reset",
    responses: { [Status.OK]: z.object({ usersReset: z.number() }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }) },
  },
  adminListGroups: {
    type: "standard", method: "GET", path: "/admin/groups",
    responses: { [Status.OK]: z.array(z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), memberCount: z.number(), createdAt: z.string() })) },
  },
  adminCreateGroup: {
    type: "standard", method: "POST", path: "/admin/groups",
    body: z.object({ name: z.string().min(1), description: z.string().optional() }),
    responses: { [Status.Created]: z.object({ id: z.string(), name: z.string(), description: z.string().nullable(), createdAt: z.string() }) },
  },
  adminDeleteGroup: {
    type: "standard", method: "DELETE", path: "/admin/groups/:id", params: z.object({ id: z.string() }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminGetGroup: {
    type: "standard", method: "GET", path: "/admin/groups/:id", params: z.object({ id: z.string() }),
    responses: { [Status.OK]: z.object({
      id: z.string(), name: z.string(), description: z.string().nullable(), createdAt: z.string(),
      members: z.array(z.object({ userId: z.string(), name: z.string(), email: z.string(), role: z.enum(["owner", "admin", "member"]), joinedAt: z.string() })),
    }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminAddGroupMember: {
    type: "standard", method: "POST", path: "/admin/groups/:id/members", params: z.object({ id: z.string() }),
    body: z.object({ userId: z.string(), role: z.enum(["owner", "admin", "member"]).default("member") }),
    responses: { [Status.Created]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.BadRequest]: z.object({ error: z.string() }), [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminUpdateGroupMember: {
    type: "standard", method: "PATCH", path: "/admin/groups/:id/members/:userId", params: z.object({ id: z.string(), userId: z.string() }),
    body: z.object({ role: z.enum(["owner", "admin", "member"]) }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
  adminRemoveGroupMember: {
    type: "standard", method: "DELETE", path: "/admin/groups/:id/members/:userId", params: z.object({ id: z.string(), userId: z.string() }),
    responses: { [Status.OK]: z.object({ success: z.boolean() }) },
    errorResponses: { [Status.NotFound]: z.object({ error: z.string() }) },
  },
});
