CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "username" text NOT NULL,
  "display_username" text,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "role" text DEFAULT 'user' NOT NULL,
  "credit_balance" numeric(20,8) DEFAULT 0 NOT NULL,
  "default_monthly_credits" numeric(20,8) DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "api_enabled" boolean DEFAULT true NOT NULL,
  "must_change_password" boolean DEFAULT false NOT NULL,
  CONSTRAINT "user_role_check" CHECK ("role" in ('user', 'admin')),
  CONSTRAINT "user_credit_balance_check" CHECK ("credit_balance" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_username_normalized_unique" ON "user" (lower("username"));
--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_normalized_unique" ON "user" (lower("email"));
--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");
--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_subject_unique" ON "account" ("provider_id", "account_id");
--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");
--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "installation" (
  "id" text PRIMARY KEY DEFAULT 'main' NOT NULL,
  "setup_completed_at" timestamp with time zone,
  "local_login_enabled" boolean DEFAULT true NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "installation_singleton_check" CHECK ("id" = 'main')
);
--> statement-breakpoint
INSERT INTO "installation" ("id", "created_at", "updated_at") VALUES ('main', now(), now());
--> statement-breakpoint
CREATE TABLE "groups" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_normalized_unique" ON "groups" (lower("name"));
--> statement-breakpoint
CREATE TABLE "group_members" (
  "group_id" text NOT NULL REFERENCES "groups"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "role" text DEFAULT 'member' NOT NULL,
  "source" text DEFAULT 'manual' NOT NULL,
  "joined_at" timestamp with time zone NOT NULL,
  CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY ("group_id", "user_id"),
  CONSTRAINT "group_member_role_check" CHECK ("role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE INDEX "group_members_user_id_idx" ON "group_members" ("user_id");
--> statement-breakpoint
CREATE TABLE "auth_providers" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "provider_key" text NOT NULL UNIQUE,
  "label" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "secret_envelope" text,
  "last_tested_at" timestamp with time zone,
  "last_test_succeeded" boolean,
  "last_test_message" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "auth_provider_type_check" CHECK ("type" in ('oidc', 'trusted_header'))
);
--> statement-breakpoint
CREATE TABLE "application_settings" (
  "id" text PRIMARY KEY DEFAULT 'main' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "product_name" text DEFAULT 'LLM Proxy' NOT NULL,
  "tagline" text DEFAULT 'Secure, metered access to AI models' NOT NULL,
  "logo_url" text,
  "favicon_url" text,
  "primary_color" text DEFAULT '#2563eb' NOT NULL,
  "primary_foreground_color" text DEFAULT '#ffffff' NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "application_settings_singleton_check" CHECK ("id" = 'main')
);
--> statement-breakpoint
INSERT INTO "application_settings" ("id", "updated_at") VALUES ('main', now());
--> statement-breakpoint
CREATE TABLE "branding_assets" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL UNIQUE,
  "mime_type" text NOT NULL,
  "bytes" bytea NOT NULL,
  "byte_length" integer NOT NULL,
  "digest" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "branding_asset_kind_check" CHECK ("kind" in ('logo', 'favicon'))
);
--> statement-breakpoint
CREATE TABLE "aws_configuration" (
  "id" text PRIMARY KEY DEFAULT 'main' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "default_region" text,
  "access_key_id" text,
  "secret_access_key_envelope" text,
  "session_token_envelope" text,
  "last_tested_at" timestamp with time zone,
  "last_test_succeeded" boolean,
  "last_test_message" text,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "aws_configuration_singleton_check" CHECK ("id" = 'main')
);
--> statement-breakpoint
INSERT INTO "aws_configuration" ("id", "updated_at") VALUES ('main', now());
--> statement-breakpoint
CREATE TABLE "models" (
  "id" text PRIMARY KEY NOT NULL,
  "model_id" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "provider" text DEFAULT 'bedrock' NOT NULL,
  "input_price_per_m_tok" numeric(20,8) DEFAULT 0 NOT NULL,
  "output_price_per_m_tok" numeric(20,8) DEFAULT 0 NOT NULL,
  "cache_write_5m_price_per_m_tok" numeric(20,8),
  "cache_write_1h_price_per_m_tok" numeric(20,8),
  "cache_read_price_per_m_tok" numeric(20,8),
  "context_window" integer,
  "max_output_tokens" integer DEFAULT 32000 NOT NULL,
  "thinking" boolean DEFAULT false NOT NULL,
  "managed_cache" boolean DEFAULT false NOT NULL,
  "region" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "key_hash" text NOT NULL UNIQUE,
  "key_prefix" text NOT NULL,
  "scopes" text[] DEFAULT '{"llm.invoke","models.read","credits.read"}' NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" ("user_id");
--> statement-breakpoint
CREATE TABLE "management_api_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "key_hash" text NOT NULL UNIQUE,
  "key_prefix" text NOT NULL,
  "scopes" text[] NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "time" timestamp with time zone NOT NULL,
  "request_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE restrict,
  "api_key_id" text REFERENCES "api_keys"("id") ON DELETE set null,
  "model" text,
  "source" text DEFAULT 'api' NOT NULL,
  "type" text NOT NULL,
  "description" text,
  "credits_added" numeric(20,8) DEFAULT 0 NOT NULL,
  "credits_consumed" numeric(20,8) DEFAULT 0 NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cache_read_tokens" integer DEFAULT 0 NOT NULL,
  "cache_write_5m_tokens" integer DEFAULT 0 NOT NULL,
  "cache_write_1h_tokens" integer DEFAULT 0 NOT NULL,
  "input_cost" numeric(20,8) DEFAULT 0 NOT NULL,
  "output_cost" numeric(20,8) DEFAULT 0 NOT NULL,
  "cache_read_cost" numeric(20,8) DEFAULT 0 NOT NULL,
  "cache_write_5m_cost" numeric(20,8) DEFAULT 0 NOT NULL,
  "cache_write_1h_cost" numeric(20,8) DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_events_request_id_unique" ON "credit_events" ("request_id");
--> statement-breakpoint
CREATE INDEX "credit_events_user_time_idx" ON "credit_events" ("user_id", "time");
--> statement-breakpoint
CREATE INDEX "credit_events_model_time_idx" ON "credit_events" ("model", "time");
--> statement-breakpoint
CREATE TABLE "audit_events" (
  "id" text PRIMARY KEY NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "request_id" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" ("created_at");
--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" ("target_type", "target_id");
