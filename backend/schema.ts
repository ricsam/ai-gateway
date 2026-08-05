import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() { return "bytea"; },
});

export const userTable = pgTable("user", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  displayUsername: text("display_username"),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  role: text("role").notNull().default("user"),
  creditBalance: numeric("credit_balance", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  defaultMonthlyCredits: numeric("default_monthly_credits", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  apiEnabled: boolean("api_enabled").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
}, (table) => [
  uniqueIndex("user_username_normalized_unique").on(sql`lower(${table.username})`),
  uniqueIndex("user_email_normalized_unique").on(sql`lower(${table.email})`),
  check("user_role_check", sql`${table.role} in ('user', 'admin')`),
  check("user_credit_balance_check", sql`${table.creditBalance} >= 0`),
]);

export const sessionTable = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
}, (table) => [index("session_user_id_idx").on(table.userId)]);

export const accountTable = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("account_provider_subject_unique").on(table.providerId, table.accountId),
  index("account_user_id_idx").on(table.userId),
]);

export const verificationTable = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

export const installationTable = pgTable("installation", {
  id: text("id").primaryKey().default("main"),
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
  localLoginEnabled: boolean("local_login_enabled").notNull().default(true),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [check("installation_singleton_check", sql`${table.id} = 'main'`)]);

export const groupsTable = pgTable("groups", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [uniqueIndex("groups_name_normalized_unique").on(sql`lower(${table.name})`)]);

export const groupMembersTable = pgTable("group_members", {
  groupId: text("group_id").notNull().references(() => groupsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  source: text("source").notNull().default("manual"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.groupId, table.userId] }),
  index("group_members_user_id_idx").on(table.userId),
  check("group_member_role_check", sql`${table.role} in ('owner', 'admin', 'member')`),
]);

export const authProvidersTable = pgTable("auth_providers", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  type: text("type").notNull(),
  providerKey: text("provider_key").notNull(),
  label: text("label").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  secretEnvelope: text("secret_envelope"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestSucceeded: boolean("last_test_succeeded"),
  lastTestMessage: text("last_test_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("auth_providers_key_unique").on(table.providerKey),
  check("auth_provider_type_check", sql`${table.type} in ('oidc', 'trusted_header')`),
]);

export const applicationSettingsTable = pgTable("application_settings", {
  id: text("id").primaryKey().default("main"),
  revision: integer("revision").notNull().default(1),
  productName: text("product_name").notNull().default("AI Gateway"),
  tagline: text("tagline").notNull().default("Secure, metered access to AI models"),
  logoUrl: text("logo_url"),
  faviconUrl: text("favicon_url"),
  primaryColor: text("primary_color").notNull().default("#2563eb"),
  primaryForegroundColor: text("primary_foreground_color").notNull().default("#ffffff"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [check("application_settings_singleton_check", sql`${table.id} = 'main'`)]);

export const brandingAssetsTable = pgTable("branding_assets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  kind: text("kind").notNull(),
  mimeType: text("mime_type").notNull(),
  bytes: bytea("bytes").notNull(),
  byteLength: integer("byte_length").notNull(),
  digest: text("digest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  uniqueIndex("branding_assets_kind_unique").on(table.kind),
  uniqueIndex("branding_assets_digest_unique").on(table.digest),
  check("branding_asset_kind_check", sql`${table.kind} in ('logo', 'favicon')`),
]);

export const awsConfigurationTable = pgTable("aws_configuration", {
  id: text("id").primaryKey().default("main"),
  revision: integer("revision").notNull().default(1),
  defaultRegion: text("default_region"),
  accessKeyId: text("access_key_id"),
  secretAccessKeyEnvelope: text("secret_access_key_envelope"),
  sessionTokenEnvelope: text("session_token_envelope"),
  lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
  lastTestSucceeded: boolean("last_test_succeeded"),
  lastTestMessage: text("last_test_message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [check("aws_configuration_singleton_check", sql`${table.id} = 'main'`)]);

export const modelsTable = pgTable("models", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  modelId: text("model_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  provider: text("provider").notNull().default("bedrock"),
  inputPricePerMTok: numeric("input_price_per_m_tok", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  outputPricePerMTok: numeric("output_price_per_m_tok", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheWrite5mPricePerMTok: numeric("cache_write_5m_price_per_m_tok", { precision: 20, scale: 8, mode: "number" }),
  cacheWrite1hPricePerMTok: numeric("cache_write_1h_price_per_m_tok", { precision: 20, scale: 8, mode: "number" }),
  cacheReadPricePerMTok: numeric("cache_read_price_per_m_tok", { precision: 20, scale: 8, mode: "number" }),
  contextWindow: integer("context_window"),
  maxOutputTokens: integer("max_output_tokens").notNull().default(32000),
  thinking: boolean("thinking").notNull().default(false),
  managedCache: boolean("managed_cache").notNull().default(false),
  region: text("region"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

export const apiKeysTable = pgTable("api_keys", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(), keyHash: text("key_hash").notNull().unique(), keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").array().notNull().default(["ai.invoke", "models.read", "credits.read"]),
  enabled: boolean("enabled").notNull().default(true), expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }), lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [index("api_keys_user_id_idx").on(table.userId)]);

export const managementApiKeysTable = pgTable("management_api_keys", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(), keyHash: text("key_hash").notNull().unique(), keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").array().notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }), lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdByUserId: text("created_by_user_id").references(() => userTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

// Append-only TimescaleDB hypertable. Hypertable uniqueness must include the
// partitioning column, and historical usage must survive user/key deletion, so
// userId and apiKeyId intentionally do not have foreign keys.
export const creditEventsTable = pgTable("credit_events", {
  id: text("id").notNull().$defaultFn(() => crypto.randomUUID()),
  time: timestamp("time", { withTimezone: true }).notNull().$defaultFn(() => new Date()), requestId: text("request_id").notNull(),
  userId: text("user_id").notNull(), apiKeyId: text("api_key_id"), model: text("model"),
  source: text("source").notNull().default("api"), type: text("type").notNull(), description: text("description"),
  creditsAdded: numeric("credits_added", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  creditsConsumed: numeric("credits_consumed", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0), outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0), cacheWrite5mTokens: integer("cache_write_5m_tokens").notNull().default(0),
  cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull().default(0),
  inputCost: numeric("input_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  outputCost: numeric("output_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheReadCost: numeric("cache_read_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheWrite5mCost: numeric("cache_write_5m_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheWrite1hCost: numeric("cache_write_1h_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.id, table.time], name: "credit_events_id_time_pk" }),
  uniqueIndex("credit_events_request_time_unique").on(table.requestId, table.time),
  index("credit_events_user_time_idx").on(table.userId, table.time),
  index("credit_events_model_time_idx").on(table.model, table.time),
]);

// Normal PostgreSQL table used to provide request-level exactly-once settlement.
// TimescaleDB requires every hypertable unique key to include the partitioning
// time, so request IDs cannot be made globally unique on credit_events itself.
export const usageRequestReceiptsTable = pgTable("usage_request_receipts", {
  requestId: text("request_id").primaryKey(),
  userId: text("user_id").notNull(),
  requestedAmount: numeric("requested_amount", { precision: 20, scale: 8, mode: "number" }).notNull(),
  status: text("status").notNull().default("pending"),
  creditsCharged: numeric("credits_charged", { precision: 20, scale: 8, mode: "number" }),
  balanceAfter: numeric("balance_after", { precision: 20, scale: 8, mode: "number" }),
  partiallyCharged: boolean("partially_charged"),
  eventId: text("event_id"),
  eventTime: timestamp("event_time", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("usage_request_receipts_user_created_idx").on(table.userId, table.createdAt),
  check("usage_request_receipts_status_check", sql`${table.status} in ('pending', 'complete')`),
  check("usage_request_receipts_amount_check", sql`${table.requestedAmount} >= 0`),
]);

export const auditEventsTable = pgTable("audit_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  actorType: text("actor_type").notNull(), actorId: text("actor_id"), action: text("action").notNull(),
  targetType: text("target_type").notNull(), targetId: text("target_id"), requestId: text("request_id").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [index("audit_events_created_at_idx").on(table.createdAt), index("audit_events_target_idx").on(table.targetType, table.targetId)]);
