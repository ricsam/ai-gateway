ALTER TABLE "application_settings" ADD COLUMN "remote_image_urls_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "reasoning_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "models" ADD COLUMN "default_reasoning_effort" text;