CREATE TABLE "model_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"upstream_model_id" text NOT NULL,
	"thinking" boolean NOT NULL,
	"effort" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_aliases_model_id_unique" UNIQUE("model_id"),
	CONSTRAINT "model_aliases_slug_check" CHECK ("model_aliases"."model_id" ~ '^[a-z0-9._-]{1,128}$'),
	CONSTRAINT "model_aliases_effort_check" CHECK ("model_aliases"."effort" in ('low', 'medium', 'high', 'xhigh', 'max'))
);
--> statement-breakpoint
CREATE TABLE "model_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"tiers" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_apps_name_unique" UNIQUE("name"),
	CONSTRAINT "model_apps_name_check" CHECK ("model_apps"."name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_upstream_model_id_models_id_fk" FOREIGN KEY ("upstream_model_id") REFERENCES "public"."models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_aliases_upstream_idx" ON "model_aliases" USING btree ("upstream_model_id");