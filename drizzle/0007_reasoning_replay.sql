-- Claude reasoning blocks (text with signature, or redacted content) of
-- OpenAI-compatible responses, sent back in later turns of the same conversation
-- so Claude keeps its earlier thinking. Rows belong to one user and upstream
-- model, expire after days of disuse and are deleted with their user. Inference
-- settings gain a switch that turns replay (and storage) off.
CREATE TABLE "reasoning_replay_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"model_id" text NOT NULL,
	"lookup_key" text NOT NULL,
	"prefix_hash" text NOT NULL,
	"predecessor_id" text,
	"request_id" text NOT NULL,
	"payload" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_settings" ADD COLUMN "reasoning_replay_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reasoning_replay_entries" ADD CONSTRAINT "reasoning_replay_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reasoning_replay_entries_lookup_unique" ON "reasoning_replay_entries" USING btree ("user_id","model_id","lookup_key");--> statement-breakpoint
CREATE INDEX "reasoning_replay_entries_expires_idx" ON "reasoning_replay_entries" USING btree ("expires_at");