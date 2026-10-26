CREATE TABLE "conversation_cache_boundaries" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"version" text NOT NULL,
	"message_index" integer NOT NULL,
	"content_index" integer NOT NULL,
	"prefix_hash" text NOT NULL,
	"ttl" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "conversation_cache_boundaries_indices_check" CHECK ("conversation_cache_boundaries"."message_index" >= 0 and "conversation_cache_boundaries"."content_index" >= 0),
	CONSTRAINT "conversation_cache_boundaries_ttl_check" CHECK ("conversation_cache_boundaries"."ttl" in ('5m', '1h'))
);
--> statement-breakpoint
ALTER TABLE "conversation_cache_boundaries" ADD CONSTRAINT "conversation_cache_boundaries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_cache_boundaries_expiry_idx" ON "conversation_cache_boundaries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "conversation_cache_boundaries_user_idx" ON "conversation_cache_boundaries" USING btree ("user_id");