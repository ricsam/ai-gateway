import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  numeric,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Better Auth user record plus server-owned proxy authorization and billing fields.
export const userTable = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  role: text("role").notNull().default("user"), // user | admin
  creditBalance: numeric("credit_balance", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  defaultMonthlyCredits: numeric("default_monthly_credits", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  apiEnabled: boolean("api_enabled").notNull().default(true),
});

export const sessionTable = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => userTable.id, { onDelete: "cascade" }),
}, (table) => [index("session_user_id_idx").on(table.userId)]);

export const accountTable = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(), // stable OIDC subject
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => userTable.id, { onDelete: "cascade" }),
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

export const teamsTable = pgTable("teams", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
});

export const teamMembersTable = pgTable("team_members", {
  teamId: text("team_id").notNull().references(() => teamsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // owner | admin | member
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.userId] }),
  index("team_members_user_id_idx").on(table.userId),
]);

// Bedrock is the only provider in this release; the public API remains provider-neutral.
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
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  scopes: text("scopes").array().notNull().default(["llm.invoke", "models.read", "credits.read"]),
  enabled: boolean("enabled").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
}, (table) => [index("api_keys_user_id_idx").on(table.userId)]);

// Append-only usage and credit ledger. The primary key makes individual requests auditable
// on standard PostgreSQL without requiring TimescaleDB.
export const creditEventsTable = pgTable("credit_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  time: timestamp("time", { withTimezone: true }).notNull().$defaultFn(() => new Date()),
  requestId: text("request_id").notNull(),
  userId: text("user_id").notNull().references(() => userTable.id, { onDelete: "restrict" }),
  apiKeyId: text("api_key_id").references(() => apiKeysTable.id, { onDelete: "set null" }),
  model: text("model"),
  source: text("source").notNull().default("api"), // api | playground | system
  type: text("type").notNull(), // usage | monthly_reset | admin_adjustment
  description: text("description"),
  creditsAdded: numeric("credits_added", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  creditsConsumed: numeric("credits_consumed", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWrite5mTokens: integer("cache_write_5m_tokens").notNull().default(0),
  cacheWrite1hTokens: integer("cache_write_1h_tokens").notNull().default(0),
  inputCost: numeric("input_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  outputCost: numeric("output_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheReadCost: numeric("cache_read_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheWrite5mCost: numeric("cache_write_5m_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
  cacheWrite1hCost: numeric("cache_write_1h_cost", { precision: 20, scale: 8, mode: "number" }).notNull().default(0),
}, (table) => [
  uniqueIndex("credit_events_request_id_unique").on(table.requestId),
  index("credit_events_user_time_idx").on(table.userId, table.time),
  index("credit_events_model_time_idx").on(table.model, table.time),
]);

export const settingsTable = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
});
