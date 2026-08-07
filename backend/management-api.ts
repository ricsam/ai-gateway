import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import db from "./db";
import { hashApiKey } from "./api-key-utils";
import { getBedrockClient, invalidateBedrockClients, ProviderNotConfiguredError } from "./bedrock";
import { invalidateAuthProviderRuntime } from "./auth-provider-runtime";
import { validateBrandingImage } from "./branding-assets";
import { ManagementAuthError, MANAGEMENT_SCOPES, requireManagementPrincipal, type ManagementPrincipal, type ManagementScope } from "./management-auth";
import { fetchOidcDiscoveryMetadata, oidcDiscoveryUrl, requiresAuthorizationResponseIssuer } from "./oidc-metadata";
import {
  applicationSettingsTable, auditEventsTable, authProvidersTable, awsConfigurationTable, brandingAssetsTable,
  creditEventsTable, groupMembersTable, groupsTable, managementApiKeysTable, modelsTable, userTable,
} from "./schema";
import { applySecretWrite, maskAccessKey, secretStatus, type SecretWrite } from "./settings-crypto";
import resetCredits from "./jobs/reset-credits";
import {
  getBalanceBurndown, getCreditsConsumed, getGroupSummary, getGroupUserBurndowns,
  getModelSummary, getTokensConsumed, getUsageByModel, getUserSummary,
  validateBucketSize, validateTimeRange, type AnalyticsScope,
} from "./analytics-service";
import { bulkUpdateUsersByGroups, createLocalUser, deleteUser, setUserGroups, setUserPassword, updateUser } from "./user-service";

const jsonHeaders = { "content-type": "application/json" };

function response(requestId: string, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "x-request-id": requestId } });
}
function failure(requestId: string, status: number, code: string, message: string, details?: unknown): Response {
  return response(requestId, { error: { code, message, requestId, ...(details ? { details } : {}) } }, status);
}
async function body<T>(request: Request): Promise<T> { return request.json() as Promise<T>; }
function pagination(url: URL) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  return { limit, offset };
}
function analyticsInput(url: URL) {
  const timeRange = validateTimeRange(url.searchParams.get("timeRange"));
  const bucketSize = validateBucketSize(timeRange, url.searchParams.get("bucketSize"));
  const userId = url.searchParams.get("userId")?.trim();
  const groupId = url.searchParams.get("groupId")?.trim();
  if (userId && groupId) throw new Error("Select either userId or groupId, not both");
  const scope: AnalyticsScope = userId ? { userId } : groupId ? { groupId } : {};
  return { timeRange, bucketSize, scope, userId, groupId };
}
function userDto(user: typeof userTable.$inferSelect, groups: { id: string; name: string; role: string }[] = []) {
  return { id: user.id, username: user.username, name: user.name, email: user.email, role: user.role, enabled: user.enabled,
    apiEnabled: user.apiEnabled, mustChangePassword: user.mustChangePassword, creditBalance: user.creditBalance,
    defaultMonthlyCredits: user.defaultMonthlyCredits, createdAt: user.createdAt.toISOString(), groups };
}
async function audit(principal: ManagementPrincipal, requestId: string, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown> = {}) {
  await db.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action, targetType, targetId, requestId, metadata });
}
function secretWrite(value: unknown): SecretWrite | undefined {
  if (!value) return undefined;
  if (typeof value !== "object" || !("operation" in value)) throw new Error("Secret write must specify preserve, replace, or clear");
  const write = value as SecretWrite;
  if (write.operation === "replace" && (!write.value || write.value.length > 4096)) throw new Error("Replacement secret is required and too long");
  if (!["preserve", "replace", "clear"].includes(write.operation)) throw new Error("Invalid secret operation");
  return write;
}

const managementSecurity = [{ cookieSession: [] }, { managementKey: [] }];
const OPENAPI = {
  openapi: "3.1.0", info: { title: "AI Gateway Management API", version: "1.0.0" },
  servers: [{ url: "/management/v1" }], security: managementSecurity,
  components: {
    securitySchemes: { managementKey: { type: "http", scheme: "bearer", bearerFormat: "aigm_" }, cookieSession: { type: "apiKey", in: "cookie", name: "better-auth.session_token" } },
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message", "requestId"], properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } } } } },
      TimePoint: { type: "object", required: ["time"], properties: { time: { type: "string", format: "date-time" } } },
      TokenSummary: { type: "object", required: ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWrite5mTokens", "cacheWrite1hTokens", "total"], properties: { inputTokens: { type: "integer" }, outputTokens: { type: "integer" }, cacheReadTokens: { type: "integer" }, cacheWrite5mTokens: { type: "integer" }, cacheWrite1hTokens: { type: "integer" }, total: { type: "integer" } } },
    },
    parameters: {
      TimeRange: { name: "timeRange", in: "query", schema: { type: "string", enum: ["hour", "day", "week", "month", "quarter", "year"], default: "month" } },
      BucketSize: { name: "bucketSize", in: "query", schema: { type: "string", enum: ["15s", "1m", "5m", "30m", "1h", "1d", "1w", "1mo"] } },
      UserId: { name: "userId", in: "query", schema: { type: "string" }, description: "Optional user scope; mutually exclusive with groupId" },
      GroupId: { name: "groupId", in: "query", schema: { type: "string" }, description: "Optional current-membership group scope; mutually exclusive with userId" },
    },
  },
  paths: {
    "/users": { get: { summary: "List users" }, post: { summary: "Create local user" } },
    "/users/{id}": { get: { summary: "Get user" }, patch: { summary: "Update user" }, delete: { summary: "Delete user" } },
    "/users/{id}/password": { post: { summary: "Set a local password and revoke sessions" } },
    "/users/{id}/groups": { put: { summary: "Replace a user's manual group memberships" } },
    "/users/monthly-reset": { post: { summary: "Run the monthly credit reset now" } },
    "/groups": { get: { summary: "List groups" }, post: { summary: "Create group" } },
    "/groups/{id}": { get: { summary: "Get a group and its members" }, patch: { summary: "Update a group" }, delete: { summary: "Delete a group" } },
    "/groups/{id}/members": { post: { summary: "Add a group member" } },
    "/groups/{id}/members/{userId}": { patch: { summary: "Update a membership role" }, delete: { summary: "Remove a manual membership" } },
    "/groups/bulk-user-update": { post: { summary: "Update all distinct users in selected groups" } },
    "/auth/providers": { get: { summary: "List login providers" }, post: { summary: "Create login provider" } },
    "/auth/providers/{id}": { patch: { summary: "Update a login provider" }, delete: { summary: "Delete a login provider" } },
    "/auth/providers/{id}/test": { post: { summary: "Test provider configuration" } },
    "/branding": { get: { summary: "Get branding" }, put: { summary: "Update branding" } },
    "/branding/assets/{kind}": { post: { summary: "Upload a logo or favicon" }, delete: { summary: "Delete an uploaded asset" } },
    "/aws": { get: { summary: "Get redacted AWS configuration" }, put: { summary: "Update AWS configuration" } },
    "/aws/test": { post: { summary: "Test configured AWS credentials against a Bedrock model" } },
    "/models": { get: { summary: "List configured models" } },
    "/management-keys": { get: { summary: "List management keys" }, post: { summary: "Create management key" } },
    "/management-keys/{id}": { delete: { summary: "Revoke a management key" } },
    "/audit-events": { get: { summary: "List audit events" } },
    "/usage/summary": { get: { summary: "Summarize usage over a period" } },
    "/usage/events": { get: { summary: "List metered usage ledger events" } },
    "/analytics/burndown": { get: { summary: "Gap-filled balance burndown", parameters: [{ $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/BucketSize" }, { $ref: "#/components/parameters/UserId" }, { $ref: "#/components/parameters/GroupId" }], responses: { "200": { description: "Balance points and current balance" } } } },
    "/analytics/consumed": { get: { summary: "Gap-filled credits consumed", parameters: [{ $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/BucketSize" }, { $ref: "#/components/parameters/UserId" }, { $ref: "#/components/parameters/GroupId" }], responses: { "200": { description: "Consumed credit points" } } } },
    "/analytics/by-model": { get: { summary: "Top-N model time series with Other", parameters: [{ $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/BucketSize" }, { name: "topN", in: "query", schema: { type: "integer", minimum: 1, maximum: 20, default: 5 } }], responses: { "200": { description: "Model time series" } } } },
    "/analytics/model-summary": { get: { summary: "Model token and credit summary", parameters: [{ $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/BucketSize" }], responses: { "200": { description: "Per-model summary" } } } },
    "/analytics/tokens": { get: { summary: "Stacked token time series and totals", parameters: [{ $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/BucketSize" }], responses: { "200": { description: "Token points and summary" } } } },
    "/analytics/users": { get: { summary: "Per-user usage summary", parameters: [{ $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/GroupId" }], responses: { "200": { description: "User summaries" } } } },
    "/analytics/groups": { get: { summary: "Current-membership group summary", parameters: [{ $ref: "#/components/parameters/TimeRange" }], responses: { "200": { description: "Group summaries" } } } },
    "/analytics/groups/{groupId}/user-burndowns": { get: { summary: "Per-user balance trajectories for a group", parameters: [{ name: "groupId", in: "path", required: true, schema: { type: "string" } }, { $ref: "#/components/parameters/TimeRange" }, { $ref: "#/components/parameters/BucketSize" }], responses: { "200": { description: "Per-user balance series" } } } },
  },
};

export async function handleManagementApi(request: Request): Promise<Response> {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/management\/v1/, "") || "/";
  if (path === "/openapi.json" && request.method === "GET") return response(requestId, OPENAPI);
  try {
    let match: RegExpMatchArray | null;
    if (path === "/users" && request.method === "GET") {
      await requireManagementPrincipal(request, "users.read"); const { limit, offset } = pagination(url);
      const search = url.searchParams.get("search")?.trim(); const where = search ? ilike(userTable.email, `%${search}%`) : undefined;
      const [users, totals, memberships] = await Promise.all([
        db.select().from(userTable).where(where).orderBy(asc(userTable.username)).limit(limit).offset(offset),
        db.select({ value: count() }).from(userTable).where(where),
        db.select({ userId: groupMembersTable.userId, id: groupsTable.id, name: groupsTable.name, role: groupMembersTable.role }).from(groupMembersTable).innerJoin(groupsTable, eq(groupMembersTable.groupId, groupsTable.id)),
      ]);
      return response(requestId, { data: users.map((user) => userDto(user, memberships.filter((entry) => entry.userId === user.id))), pagination: { limit, offset, total: totals[0]?.value ?? 0 } });
    }
    if (path === "/users" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "users.write");
      const user = await createLocalUser(await body(request), principal, requestId);
      return response(requestId, { data: userDto(user) }, 201);
    }
    if ((match = path.match(/^\/users\/([^/]+)$/)) && request.method === "GET") {
      await requireManagementPrincipal(request, "users.read"); const id = decodeURIComponent(match[1]!);
      const [user, memberships] = await Promise.all([
        db.select().from(userTable).where(eq(userTable.id, id)).limit(1).then((rows) => rows[0]),
        db.select({ id: groupsTable.id, name: groupsTable.name, role: groupMembersTable.role }).from(groupMembersTable).innerJoin(groupsTable, eq(groupMembersTable.groupId, groupsTable.id)).where(eq(groupMembersTable.userId, id)),
      ]);
      return user ? response(requestId, { data: userDto(user, memberships) }) : failure(requestId, 404, "not_found", "User not found");
    }
    if ((match = path.match(/^\/users\/([^/]+)$/)) && request.method === "PATCH") {
      const principal = await requireManagementPrincipal(request, "users.write");
      const user = await updateUser(decodeURIComponent(match[1]!), await body(request), principal, requestId);
      return user ? response(requestId, { data: userDto(user) }) : failure(requestId, 404, "not_found", "User not found");
    }
    if ((match = path.match(/^\/users\/([^/]+)$/)) && request.method === "DELETE") {
      const principal = await requireManagementPrincipal(request, "users.write");
      return await deleteUser(decodeURIComponent(match[1]!), principal, requestId) ? response(requestId, { success: true }) : failure(requestId, 404, "not_found", "User not found");
    }
    if ((match = path.match(/^\/users\/([^/]+)\/(enable|disable)$/)) && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "users.write");
      const user = await updateUser(decodeURIComponent(match[1]!), { enabled: match[2] === "enable" }, principal, requestId);
      return user ? response(requestId, { data: userDto(user) }) : failure(requestId, 404, "not_found", "User not found");
    }
    if ((match = path.match(/^\/users\/([^/]+)\/password$/)) && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "users.write"); const data = await body<{ password: string; mustChangePassword?: boolean }>(request);
      return await setUserPassword(decodeURIComponent(match[1]!), data.password, data.mustChangePassword ?? true, principal, requestId) ? response(requestId, { success: true }) : failure(requestId, 404, "not_found", "User not found");
    }
    if ((match = path.match(/^\/users\/([^/]+)\/groups$/)) && request.method === "PUT") {
      const principal = await requireManagementPrincipal(request, "users.write"); const data = await body<{ groupIds: string[] }>(request);
      if (!Array.isArray(data.groupIds) || data.groupIds.some((id) => typeof id !== "string")) return failure(requestId, 400, "validation_error", "groupIds must be an array of group IDs");
      return await setUserGroups(decodeURIComponent(match[1]!), data.groupIds, principal, requestId) ? response(requestId, { success: true }) : failure(requestId, 404, "not_found", "User not found");
    }
    if (path === "/users/monthly-reset" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "users.write"); const result = await resetCredits();
      await audit(principal, requestId, "credits.monthly_reset.manual", "users", null, result);
      return response(requestId, { data: result });
    }

    if (path === "/groups" && request.method === "GET") {
      await requireManagementPrincipal(request, "groups.read"); const { limit, offset } = pagination(url);
      const [groups, totals] = await Promise.all([
        db.select({ id: groupsTable.id, name: groupsTable.name, description: groupsTable.description, createdAt: groupsTable.createdAt, memberCount: sql<number>`count(${groupMembersTable.userId})::int` })
          .from(groupsTable).leftJoin(groupMembersTable, eq(groupsTable.id, groupMembersTable.groupId)).groupBy(groupsTable.id).orderBy(asc(groupsTable.name)).limit(limit).offset(offset),
        db.select({ value: count() }).from(groupsTable),
      ]);
      return response(requestId, { data: groups.map((group) => ({ ...group, createdAt: group.createdAt.toISOString() })), pagination: { limit, offset, total: totals[0]?.value ?? 0 } });
    }
    if (path === "/groups" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "groups.write"); const data = await body<{ name: string; description?: string }>(request);
      if (!data.name?.trim()) return failure(requestId, 400, "validation_error", "Group name is required");
      const [group] = await db.insert(groupsTable).values({ name: data.name.trim(), description: data.description?.trim() || null }).returning();
      await audit(principal, requestId, "group.created", "group", group!.id, { name: group!.name }); return response(requestId, { data: group }, 201);
    }
    if (path === "/groups/bulk-user-update" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "users.write");
      const data = await body<{ groupIds: string[]; enabled?: boolean; apiEnabled?: boolean; defaultMonthlyCredits?: number }>(request);
      if (!Array.isArray(data.groupIds) || data.groupIds.some((id) => typeof id !== "string")) return failure(requestId, 400, "validation_error", "groupIds must be an array of group IDs");
      const usersUpdated = await bulkUpdateUsersByGroups(data.groupIds, { enabled: data.enabled, apiEnabled: data.apiEnabled, defaultMonthlyCredits: data.defaultMonthlyCredits }, principal, requestId);
      return response(requestId, { data: { usersUpdated } });
    }
    if ((match = path.match(/^\/groups\/([^/]+)$/)) && request.method === "GET") {
      await requireManagementPrincipal(request, "groups.read"); const id = decodeURIComponent(match[1]!);
      const [group] = await db.select().from(groupsTable).where(eq(groupsTable.id, id)).limit(1);
      if (!group) return failure(requestId, 404, "not_found", "Group not found");
      const members = await db.select({
        userId: userTable.id, username: userTable.username, name: userTable.name, email: userTable.email,
        role: groupMembersTable.role, source: groupMembersTable.source, joinedAt: groupMembersTable.joinedAt,
        enabled: userTable.enabled, apiEnabled: userTable.apiEnabled, creditBalance: userTable.creditBalance,
        defaultMonthlyCredits: userTable.defaultMonthlyCredits,
      }).from(groupMembersTable).innerJoin(userTable, eq(groupMembersTable.userId, userTable.id)).where(eq(groupMembersTable.groupId, id));
      return response(requestId, { data: { ...group, members } });
    }
    if ((match = path.match(/^\/groups\/([^/]+)$/)) && request.method === "PATCH") {
      const principal = await requireManagementPrincipal(request, "groups.write"); const data = await body<{ name?: string; description?: string | null }>(request);
      if (data.name !== undefined && !data.name.trim()) return failure(requestId, 400, "validation_error", "Group name is required");
      const values = { ...(data.name !== undefined ? { name: data.name.trim() } : {}), ...(data.description !== undefined ? { description: data.description?.trim() || null } : {}), updatedAt: new Date() };
      const id = decodeURIComponent(match[1]!);
      const group = await db.transaction(async (tx) => {
        const [changed] = await tx.update(groupsTable).set(values).where(eq(groupsTable.id, id)).returning();
        if (changed) await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action: "group.updated", targetType: "group", targetId: changed.id, requestId, metadata: {} });
        return changed;
      });
      return group ? response(requestId, { data: group }) : failure(requestId, 404, "not_found", "Group not found");
    }
    if ((match = path.match(/^\/groups\/([^/]+)$/)) && request.method === "DELETE") {
      const principal = await requireManagementPrincipal(request, "groups.write"); const id = decodeURIComponent(match[1]!);
      const removed = await db.transaction(async (tx) => {
        const rows = await tx.delete(groupsTable).where(eq(groupsTable.id, id)).returning({ id: groupsTable.id });
        if (rows.length) await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action: "group.deleted", targetType: "group", targetId: id, requestId, metadata: {} });
        return rows;
      });
      return removed.length ? response(requestId, { success: true }) : failure(requestId, 404, "not_found", "Group not found");
    }
    if ((match = path.match(/^\/groups\/([^/]+)\/members$/)) && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "groups.write"); const data = await body<{ userId: string; role?: string }>(request);
      if (!data.userId || !["owner", "admin", "member"].includes(data.role ?? "member")) return failure(requestId, 400, "validation_error", "A user and valid membership role are required");
      await db.insert(groupMembersTable).values({ groupId: decodeURIComponent(match[1]!), userId: data.userId, role: data.role ?? "member" });
      await audit(principal, requestId, "group.member.added", "group", decodeURIComponent(match[1]!), { userId: data.userId }); return response(requestId, { success: true }, 201);
    }
    if ((match = path.match(/^\/groups\/([^/]+)\/members\/([^/]+)$/)) && request.method === "PATCH") {
      const principal = await requireManagementPrincipal(request, "groups.write"); const data = await body<{ role: string }>(request);
      if (!["owner", "admin", "member"].includes(data.role)) return failure(requestId, 400, "validation_error", "Invalid membership role");
      const changed = await db.update(groupMembersTable).set({ role: data.role }).where(and(eq(groupMembersTable.groupId, decodeURIComponent(match[1]!)), eq(groupMembersTable.userId, decodeURIComponent(match[2]!)))).returning();
      if (!changed.length) return failure(requestId, 404, "not_found", "Membership not found"); await audit(principal, requestId, "group.member.updated", "group", decodeURIComponent(match[1]!), { userId: decodeURIComponent(match[2]!), role: data.role }); return response(requestId, { success: true });
    }
    if ((match = path.match(/^\/groups\/([^/]+)\/members\/([^/]+)$/)) && request.method === "DELETE") {
      const principal = await requireManagementPrincipal(request, "groups.write");
      const removed = await db.delete(groupMembersTable).where(and(eq(groupMembersTable.groupId, decodeURIComponent(match[1]!)), eq(groupMembersTable.userId, decodeURIComponent(match[2]!)))).returning();
      if (!removed.length) return failure(requestId, 404, "not_found", "Membership not found"); await audit(principal, requestId, "group.member.removed", "group", decodeURIComponent(match[1]!), { userId: decodeURIComponent(match[2]!) }); return response(requestId, { success: true });
    }

    if (path === "/branding" && request.method === "GET") {
      await requireManagementPrincipal(request, "branding.read"); const [settings] = await db.select().from(applicationSettingsTable).where(eq(applicationSettingsTable.id, "main")).limit(1); return response(requestId, { data: settings });
    }
    if (path === "/branding" && request.method === "PUT") {
      const principal = await requireManagementPrincipal(request, "branding.write"); const data = await body<any>(request);
      const [current] = await db.select().from(applicationSettingsTable).where(eq(applicationSettingsTable.id, "main")).limit(1);
      if (!current || data.revision !== current.revision) return failure(requestId, 409, "revision_conflict", "Branding configuration has changed");
      if (data.primaryColor && !/^#[0-9a-f]{6}$/i.test(data.primaryColor)) return failure(requestId, 400, "validation_error", "Primary color must be a six-digit hex color");
      const allowed = { productName: data.productName, tagline: data.tagline, logoUrl: data.logoUrl, faviconUrl: data.faviconUrl, primaryColor: data.primaryColor, primaryForegroundColor: data.primaryForegroundColor };
      const values = Object.fromEntries(Object.entries(allowed).filter(([, value]) => value !== undefined));
      const settings = await db.transaction(async (tx) => {
        const [changed] = await tx.update(applicationSettingsTable).set({ ...values, revision: current.revision + 1, updatedAt: new Date() }).where(eq(applicationSettingsTable.id, "main")).returning();
        await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action: "branding.updated", targetType: "application_settings", targetId: "main", requestId, metadata: {} });
        return changed!;
      });
      return response(requestId, { data: settings });
    }
    if ((match = path.match(/^\/branding\/assets\/(logo|favicon)$/)) && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "branding.write"); const bytes = new Uint8Array(await request.arrayBuffer());
      const mime = request.headers.get("content-type")?.split(";", 1)[0] || ""; const kind = match[1]! as "logo" | "favicon";
      try { validateBrandingImage(bytes, mime, kind); } catch (error) { return failure(requestId, 400, "invalid_asset", error instanceof Error ? error.message : "Invalid image"); }
      const digest = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
      const asset = await db.transaction(async (tx) => {
        const [changed] = await tx.insert(brandingAssetsTable).values({ kind, mimeType: mime, bytes: Buffer.from(bytes), byteLength: bytes.byteLength, digest }).onConflictDoUpdate({ target: brandingAssetsTable.kind, set: { mimeType: mime, bytes: Buffer.from(bytes), byteLength: bytes.byteLength, digest, createdAt: new Date() } }).returning();
        await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action: "branding.asset.updated", targetType: "branding_asset", targetId: kind, requestId, metadata: { mime, byteLength: bytes.byteLength, digest } });
        return changed!;
      });
      return response(requestId, { data: { kind, digest, url: `/api/branding/assets/${kind}/${asset.digest}` } }, 201);
    }
    if ((match = path.match(/^\/branding\/assets\/(logo|favicon)$/)) && request.method === "DELETE") {
      const principal = await requireManagementPrincipal(request, "branding.write"); const kind = match[1]!;
      await db.transaction(async (tx) => {
        await tx.delete(brandingAssetsTable).where(eq(brandingAssetsTable.kind, kind));
        await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action: "branding.asset.deleted", targetType: "branding_asset", targetId: kind, requestId, metadata: {} });
      });
      return response(requestId, { success: true });
    }

    if (path === "/aws" && request.method === "GET") {
      await requireManagementPrincipal(request, "aws.read"); const [aws] = await db.select().from(awsConfigurationTable).where(eq(awsConfigurationTable.id, "main")).limit(1);
      return response(requestId, { data: aws && { revision: aws.revision, defaultRegion: aws.defaultRegion, accessKeyId: maskAccessKey(aws.accessKeyId), secretAccessKey: secretStatus(aws.secretAccessKeyEnvelope), sessionToken: secretStatus(aws.sessionTokenEnvelope), lastTestedAt: aws.lastTestedAt, lastTestSucceeded: aws.lastTestSucceeded, lastTestMessage: aws.lastTestMessage } });
    }
    if (path === "/aws" && request.method === "PUT") {
      const principal = await requireManagementPrincipal(request, "aws.write"); const data = await body<any>(request); const [current] = await db.select().from(awsConfigurationTable).where(eq(awsConfigurationTable.id, "main")).limit(1);
      if (!current || data.revision !== current.revision) return failure(requestId, 409, "revision_conflict", "AWS configuration has changed");
      const secretAccessKeyEnvelope = await applySecretWrite(current.secretAccessKeyEnvelope, secretWrite(data.secretAccessKey), "aws:secret-access-key");
      const sessionTokenEnvelope = await applySecretWrite(current.sessionTokenEnvelope, secretWrite(data.sessionToken), "aws:session-token");
      const accessKeyId = data.accessKeyId === undefined ? current.accessKeyId : (data.accessKeyId?.trim() || null);
      if ((accessKeyId && !secretAccessKeyEnvelope) || (!accessKeyId && secretAccessKeyEnvelope)) return failure(requestId, 400, "validation_error", "Access key ID and secret access key must be configured or cleared together");
      const aws = await db.transaction(async (tx) => {
        const [changed] = await tx.update(awsConfigurationTable).set({ accessKeyId, defaultRegion: data.defaultRegion?.trim() || null, secretAccessKeyEnvelope, sessionTokenEnvelope, revision: current.revision + 1, updatedAt: new Date() }).where(eq(awsConfigurationTable.id, "main")).returning();
        await tx.insert(auditEventsTable).values({ actorType: principal.actorType, actorId: principal.actorId, action: "aws.updated", targetType: "aws_configuration", targetId: "main", requestId, metadata: { configured: Boolean(accessKeyId), defaultRegion: changed!.defaultRegion } });
        return changed!;
      });
      invalidateBedrockClients();
      return response(requestId, { data: { revision: aws.revision, defaultRegion: aws.defaultRegion, accessKeyId: maskAccessKey(aws.accessKeyId), secretAccessKey: secretStatus(aws.secretAccessKeyEnvelope), sessionToken: secretStatus(aws.sessionTokenEnvelope) } });
    }
    if (path === "/aws/test" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "aws.write"); const data = await body<{ modelId: string; region?: string }>(request); const testedAt = new Date();
      if (!data.modelId?.trim()) return failure(requestId, 400, "validation_error", "A Bedrock model is required for the connection test");
      try { const client = await getBedrockClient(data.region); await client.send(new ConverseCommand({ modelId: data.modelId.trim(), messages: [{ role: "user", content: [{ text: "Reply OK" }] }], inferenceConfig: { maxTokens: 8 } }));
        await db.update(awsConfigurationTable).set({ lastTestedAt: testedAt, lastTestSucceeded: true, lastTestMessage: "Connection succeeded" }).where(eq(awsConfigurationTable.id, "main")); await audit(principal, requestId, "aws.test.succeeded", "aws_configuration", "main", { modelId: data.modelId }); return response(requestId, { success: true, message: "Connection succeeded" });
      } catch (error) { const message = error instanceof ProviderNotConfiguredError ? error.message : "Bedrock connection test failed"; await db.update(awsConfigurationTable).set({ lastTestedAt: testedAt, lastTestSucceeded: false, lastTestMessage: message }).where(eq(awsConfigurationTable.id, "main")); await audit(principal, requestId, "aws.test.failed", "aws_configuration", "main", { modelId: data.modelId }); return failure(requestId, 400, "aws_test_failed", message); }
    }

    if (path === "/models" && request.method === "GET") {
      await requireManagementPrincipal(request, "models.read");
      const models = await db.select({ id: modelsTable.id, modelId: modelsTable.modelId, name: modelsTable.name, region: modelsTable.region, enabled: modelsTable.enabled }).from(modelsTable).orderBy(asc(modelsTable.name));
      return response(requestId, { data: models });
    }

    if (path === "/auth/providers" && request.method === "GET") {
      await requireManagementPrincipal(request, "auth.read"); const providers = await db.select().from(authProvidersTable).orderBy(asc(authProvidersTable.label));
      return response(requestId, { data: providers.map(({ secretEnvelope, ...provider }) => ({ ...provider, secret: secretStatus(secretEnvelope) })) });
    }
    if (path === "/auth/providers" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "auth.write"); const data = await body<any>(request);
      if (!["oidc", "trusted_header"].includes(data.type)) return failure(requestId, 400, "validation_error", "Provider type must be oidc or trusted_header");
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(data.providerKey ?? "") || !data.label?.trim()) return failure(requestId, 400, "validation_error", "Provider key and label are required");
      if (data.enabled) return failure(requestId, 400, "validation_error", "Create providers disabled, test them, then enable them");
      if (!data.secret?.value) return failure(requestId, 400, "validation_error", "Configure the provider secret");
      if (data.type === "trusted_header" && (!Array.isArray(data.config?.sourceCidrs) || !data.config.sourceCidrs.length)) return failure(requestId, 400, "validation_error", "Trusted-header providers require at least one allowed proxy peer CIDR");
      const secretEnvelope = await applySecretWrite(null, secretWrite(data.secret), `auth-provider:${data.providerKey}`);
      const [provider] = await db.insert(authProvidersTable).values({ type: data.type, providerKey: data.providerKey, label: data.label, enabled: data.enabled ?? false, config: data.config ?? {}, secretEnvelope }).returning();
      invalidateAuthProviderRuntime(); await audit(principal, requestId, "auth.provider.created", "auth_provider", provider!.id, { type: data.type, providerKey: data.providerKey }); const { secretEnvelope: _, ...publicProvider } = provider!; return response(requestId, { data: { ...publicProvider, secret: secretStatus(provider!.secretEnvelope) } }, 201);
    }
    if ((match = path.match(/^\/auth\/providers\/([^/]+)$/)) && request.method === "PATCH") {
      const principal = await requireManagementPrincipal(request, "auth.write"); const data = await body<any>(request); const id = decodeURIComponent(match[1]!); const [current] = await db.select().from(authProvidersTable).where(eq(authProvidersTable.id, id)).limit(1);
      if (!current) return failure(requestId, 404, "not_found", "Provider not found"); if (data.revision !== current.revision) return failure(requestId, 409, "revision_conflict", "Provider configuration has changed");
      const secretEnvelope = await applySecretWrite(current.secretEnvelope, secretWrite(data.secret), `auth-provider:${current.providerKey}`);
      if ((data.enabled ?? current.enabled) && !secretEnvelope) return failure(requestId, 400, "validation_error", "Configure the provider secret before enabling it");
      if (data.enabled === true && !current.enabled && !current.lastTestSucceeded) return failure(requestId, 400, "validation_error", "Test the provider successfully before enabling it");
      if (data.enabled === true && !current.enabled && data.config !== undefined && JSON.stringify(data.config) !== JSON.stringify(current.config)) return failure(requestId, 400, "validation_error", "Save and retest configuration changes before enabling the provider");
      if (data.enabled === true && !current.enabled && current.type === "oidc" && typeof (current.config as Record<string, unknown>).authorizationResponseIssuerParameterSupported !== "boolean") return failure(requestId, 400, "validation_error", "Retest OIDC discovery before enabling the provider");
      if (data.enabled === true && !current.enabled && data.secret?.operation !== "preserve" && data.secret !== undefined) return failure(requestId, 400, "validation_error", "Save and retest secret changes before enabling the provider");
      if (current.type === "trusted_header" && (!Array.isArray((data.config ?? current.config)?.sourceCidrs) || !(data.config ?? current.config).sourceCidrs.length)) return failure(requestId, 400, "validation_error", "Trusted-header providers require at least one allowed proxy peer CIDR");
      const configurationChanged = data.config !== undefined && JSON.stringify(data.config) !== JSON.stringify(current.config);
      const secretChanged = data.secret?.operation === "replace" || data.secret?.operation === "clear";
      const [provider] = await db.update(authProvidersTable).set({
        label: data.label?.trim() || current.label, enabled: data.enabled ?? current.enabled, config: data.config ?? current.config, secretEnvelope,
        ...(configurationChanged || secretChanged ? { lastTestSucceeded: null, lastTestMessage: null } : {}),
        revision: current.revision + 1, updatedAt: new Date(),
      }).where(eq(authProvidersTable.id, id)).returning();
      invalidateAuthProviderRuntime(); await audit(principal, requestId, "auth.provider.updated", "auth_provider", id); const { secretEnvelope: _, ...publicProvider } = provider!; return response(requestId, { data: { ...publicProvider, secret: secretStatus(provider!.secretEnvelope) } });
    }
    if ((match = path.match(/^\/auth\/providers\/([^/]+)$/)) && request.method === "DELETE") {
      const principal = await requireManagementPrincipal(request, "auth.write"); const id = decodeURIComponent(match[1]!); const removed = await db.delete(authProvidersTable).where(eq(authProvidersTable.id, id)).returning(); if (!removed.length) return failure(requestId, 404, "not_found", "Provider not found"); invalidateAuthProviderRuntime(); await audit(principal, requestId, "auth.provider.deleted", "auth_provider", id); return response(requestId, { success: true });
    }
    if ((match = path.match(/^\/auth\/providers\/([^/]+)\/test$/)) && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "auth.write"); const id = decodeURIComponent(match[1]!); const [provider] = await db.select().from(authProvidersTable).where(eq(authProvidersTable.id, id)).limit(1); if (!provider) return failure(requestId, 404, "not_found", "Provider not found");
      let success = false; let message = "Configuration is incomplete"; let discoveredConfig: Record<string, unknown> | undefined;
      if (provider.type === "oidc") {
        const config = provider.config as any;
        const issuer = typeof config.issuer === "string" ? config.issuer.trim() : "";
        const discoveryUrl = oidcDiscoveryUrl(issuer, typeof config.discoveryUrl === "string" ? config.discoveryUrl : undefined);
        if (!provider.secretEnvelope || !config.clientId || !issuer || !discoveryUrl) message = "Issuer, client ID, and client secret are required";
        else try {
          const discovery = await fetchOidcDiscoveryMetadata(discoveryUrl, issuer);
          success = Boolean(discovery.metadata);
          if (success) {
            const authorizationResponseIssuerParameterSupported = requiresAuthorizationResponseIssuer(discovery.metadata!);
            discoveredConfig = { ...config, authorizationResponseIssuerParameterSupported };
            message = `OIDC discovery and issuer validation succeeded; authorization-response issuer parameter ${authorizationResponseIssuerParameterSupported ? "is required" : "is not advertised"}`;
          } else message = discovery.response.ok ? "OIDC metadata is incomplete or its issuer does not match" : `OIDC discovery returned ${discovery.response.status}`;
        } catch { message = "OIDC discovery request failed"; }
      } else {
        const config = provider.config as any;
        success = Boolean(provider.secretEnvelope && config.subjectHeader && config.emailHeader && Array.isArray(config.sourceCidrs) && config.sourceCidrs.length);
        message = success ? "Trusted-header configuration is complete" : message;
      }
      const configChanged = discoveredConfig !== undefined && JSON.stringify(discoveredConfig) !== JSON.stringify(provider.config);
      await db.update(authProvidersTable).set({
        ...(discoveredConfig ? { config: discoveredConfig } : {}),
        ...(configChanged ? { revision: provider.revision + 1 } : {}),
        lastTestedAt: new Date(), lastTestSucceeded: success, lastTestMessage: message, updatedAt: new Date(),
      }).where(eq(authProvidersTable.id, id));
      if (configChanged) invalidateAuthProviderRuntime();
      await audit(principal, requestId, `auth.provider.test.${success ? "succeeded" : "failed"}`, "auth_provider", id); return response(requestId, { success, message }, success ? 200 : 400);
    }

    if (path === "/management-keys" && request.method === "GET") {
      await requireManagementPrincipal(request, "management-keys.read"); const keys = await db.select().from(managementApiKeysTable).orderBy(desc(managementApiKeysTable.createdAt)); return response(requestId, { data: keys.map(({ keyHash: _, ...key }) => key) });
    }
    if (path === "/management-keys" && request.method === "POST") {
      const principal = await requireManagementPrincipal(request, "management-keys.write"); const data = await body<{ name: string; scopes: string[]; expiresAt?: string }>(request);
      const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
      if (!data.name?.trim() || !data.scopes?.length || data.scopes.some((scope) => !MANAGEMENT_SCOPES.includes(scope as ManagementScope))) return failure(requestId, 400, "validation_error", "Name and valid management scopes are required");
      if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) return failure(requestId, 400, "validation_error", "Expiry must be a future date");
      const rawKey = `aigm_${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""); const [key] = await db.insert(managementApiKeysTable).values({ name: data.name.trim(), keyHash: await hashApiKey(rawKey), keyPrefix: rawKey.slice(0, 13), scopes: [...new Set(data.scopes)], expiresAt, createdByUserId: principal.userId }).returning();
      await audit(principal, requestId, "management_key.created", "management_api_key", key!.id, { name: key!.name, scopes: key!.scopes }); const { keyHash: _, ...publicKey } = key!; return response(requestId, { data: { ...publicKey, key: rawKey } }, 201);
    }
    if ((match = path.match(/^\/management-keys\/([^/]+)$/)) && request.method === "DELETE") {
      const principal = await requireManagementPrincipal(request, "management-keys.write"); const id = decodeURIComponent(match[1]!); const [key] = await db.update(managementApiKeysTable).set({ revokedAt: new Date() }).where(eq(managementApiKeysTable.id, id)).returning(); if (!key) return failure(requestId, 404, "not_found", "Management key not found"); await audit(principal, requestId, "management_key.revoked", "management_api_key", id); return response(requestId, { success: true });
    }
    if (path === "/audit-events" && request.method === "GET") {
      await requireManagementPrincipal(request, "audit.read"); const { limit, offset } = pagination(url);
      const action = url.searchParams.get("action")?.trim(); const targetType = url.searchParams.get("targetType")?.trim();
      const clauses = [...(action ? [eq(auditEventsTable.action, action)] : []), ...(targetType ? [eq(auditEventsTable.targetType, targetType)] : [])];
      const where = clauses.length ? and(...clauses) : undefined;
      const [events, totals] = await Promise.all([
        db.select().from(auditEventsTable).where(where).orderBy(desc(auditEventsTable.createdAt)).limit(limit).offset(offset),
        db.select({ value: count() }).from(auditEventsTable).where(where),
      ]);
      return response(requestId, { data: events, pagination: { limit, offset, total: totals[0]?.value ?? 0 } });
    }
    if (path.startsWith("/analytics/") && request.method === "GET") {
      await requireManagementPrincipal(request, "usage.read");
      const input = analyticsInput(url);
      if (path === "/analytics/burndown") return response(requestId, { data: await getBalanceBurndown(input.timeRange, input.bucketSize, input.scope) });
      if (path === "/analytics/consumed") return response(requestId, { data: await getCreditsConsumed(input.timeRange, input.bucketSize, input.scope) });
      if (path === "/analytics/by-model") {
        const topN = Number(url.searchParams.get("topN") || 5);
        if (!Number.isInteger(topN) || topN < 1 || topN > 20) return failure(requestId, 400, "validation_error", "topN must be an integer from 1 to 20");
        return response(requestId, { data: await getUsageByModel(input.timeRange, input.bucketSize, input.scope, topN) });
      }
      if (path === "/analytics/model-summary") return response(requestId, { data: await getModelSummary(input.timeRange, input.bucketSize, input.scope) });
      if (path === "/analytics/tokens") return response(requestId, { data: await getTokensConsumed(input.timeRange, input.bucketSize, input.scope) });
      if (path === "/analytics/users") return response(requestId, { data: await getUserSummary(input.timeRange, input.groupId) });
      if (path === "/analytics/groups") return response(requestId, { data: await getGroupSummary(input.timeRange) });
      const groupBurndown = path.match(/^\/analytics\/groups\/([^/]+)\/user-burndowns$/);
      if (groupBurndown) return response(requestId, { data: await getGroupUserBurndowns(input.timeRange, input.bucketSize, decodeURIComponent(groupBurndown[1]!)) });
    }
    if (path === "/usage/summary" && request.method === "GET") {
      await requireManagementPrincipal(request, "usage.read");
      const requestedDays = Number(url.searchParams.get("days") || 30);
      const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 365) : 30;
      const since = new Date(Date.now() - days * 86_400_000);
      const userId = url.searchParams.get("userId")?.trim(); const groupId = url.searchParams.get("groupId")?.trim();
      const groupUserIds = groupId ? (await db.select({ userId: groupMembersTable.userId }).from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId))).map((row) => row.userId) : null;
      const filters = [sql`${creditEventsTable.time} >= ${since}`, ...(userId ? [eq(creditEventsTable.userId, userId)] : []), ...(groupUserIds ? [groupUserIds.length ? inArray(creditEventsTable.userId, groupUserIds) : sql`false`] : [])];
      const where = and(...filters);
      const [summary] = await db.select({
        creditsConsumed: sql<number>`coalesce(sum(${creditEventsTable.creditsConsumed}), 0)::float8`,
        inputTokens: sql<number>`coalesce(sum(${creditEventsTable.inputTokens}), 0)::float8`,
        outputTokens: sql<number>`coalesce(sum(${creditEventsTable.outputTokens}), 0)::float8`,
        requests: sql<number>`count(*)::int`,
      }).from(creditEventsTable).where(where);
      const byModel = await db.select({ model: creditEventsTable.model, creditsConsumed: sql<number>`coalesce(sum(${creditEventsTable.creditsConsumed}), 0)::float8`, requests: sql<number>`count(*)::int` })
        .from(creditEventsTable).where(where).groupBy(creditEventsTable.model).orderBy(desc(sql`coalesce(sum(${creditEventsTable.creditsConsumed}), 0)`)).limit(20);
      const byUser = await db.select({ userId: userTable.id, username: userTable.username, creditsConsumed: sql<number>`coalesce(sum(${creditEventsTable.creditsConsumed}), 0)::float8`, requests: sql<number>`count(*)::int` })
        .from(creditEventsTable).innerJoin(userTable, eq(creditEventsTable.userId, userTable.id)).where(where).groupBy(userTable.id).orderBy(desc(sql`coalesce(sum(${creditEventsTable.creditsConsumed}), 0)`)).limit(50);
      return response(requestId, { data: { days, since: since.toISOString(), userId: userId || null, groupId: groupId || null, ...(summary ?? { creditsConsumed: 0, inputTokens: 0, outputTokens: 0, requests: 0 }), byModel, byUser } });
    }
    if (path === "/usage/events" && request.method === "GET") {
      await requireManagementPrincipal(request, "usage.read"); const { limit, offset } = pagination(url);
      const userId = url.searchParams.get("userId")?.trim(); const groupId = url.searchParams.get("groupId")?.trim();
      const groupUserIds = groupId ? (await db.select({ userId: groupMembersTable.userId }).from(groupMembersTable).where(eq(groupMembersTable.groupId, groupId))).map((row) => row.userId) : null;
      const clauses = [...(userId ? [eq(creditEventsTable.userId, userId)] : []), ...(groupUserIds ? [groupUserIds.length ? inArray(creditEventsTable.userId, groupUserIds) : sql`false`] : [])];
      const where = clauses.length ? and(...clauses) : undefined;
      const [events, totals] = await Promise.all([
        db.select({ id: creditEventsTable.id, time: creditEventsTable.time, userId: creditEventsTable.userId, username: userTable.username, source: creditEventsTable.source, type: creditEventsTable.type, model: creditEventsTable.model, creditsAdded: creditEventsTable.creditsAdded, creditsConsumed: creditEventsTable.creditsConsumed, inputTokens: creditEventsTable.inputTokens, outputTokens: creditEventsTable.outputTokens }).from(creditEventsTable).innerJoin(userTable, eq(creditEventsTable.userId, userTable.id)).where(where).orderBy(desc(creditEventsTable.time)).limit(limit).offset(offset),
        db.select({ value: count() }).from(creditEventsTable).where(where),
      ]);
      return response(requestId, { data: events, pagination: { limit, offset, total: totals[0]?.value ?? 0 } });
    }
    return failure(requestId, 404, "not_found", "Management endpoint not found");
  } catch (error) {
    if (error instanceof ManagementAuthError) return failure(requestId, error.status, error.code, error.message);
    if (error instanceof SyntaxError) return failure(requestId, 400, "invalid_json", "Request body must be valid JSON");
    const message = error instanceof Error ? error.message : "Request failed";
    if (/unique|duplicate/i.test(message)) return failure(requestId, 409, "conflict", "A resource with that normalized identifier already exists");
    if (/final enabled administrator|Credits cannot|Password must|Username must|email address|required|Invalid secret|Select at least|bulk update|selected groups do not exist|Display name|must be a boolean|Role must|Invalid time range|Invalid bucket size|either userId|scopeId/i.test(message)) return failure(requestId, 400, "validation_error", message);
    console.error("Management API error", { requestId, path, message }); return failure(requestId, 500, "internal_error", "Internal server error");
  }
}
