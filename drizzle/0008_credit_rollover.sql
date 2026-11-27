-- Per-account monthly credit control. Existing accounts keep the monthly reset,
-- with no rollover cap and no monthly spend limit, so their behaviour is unchanged.
-- monthly_credits_applied_at records when the monthly run last applied an account's
-- monthly credits, so a rollover adds them only once per UTC month.
ALTER TABLE "user" ADD COLUMN "monthly_credit_mode" text DEFAULT 'reset' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "rollover_cap" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "monthly_spend_limit" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "monthly_credits_applied_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_monthly_credit_mode_check" CHECK ("user"."monthly_credit_mode" in ('reset', 'rollover'));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_rollover_cap_check" CHECK ("user"."rollover_cap" >= 0);--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_monthly_spend_limit_check" CHECK ("user"."monthly_spend_limit" >= 0);