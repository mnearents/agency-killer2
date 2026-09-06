CREATE TABLE "query_log" (
	"id" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"sql_text" text NOT NULL,
	"row_count" integer NOT NULL,
	"truncated" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "seal_tier_change_events" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"from_tier" text NOT NULL,
	"to_tier" text NOT NULL,
	"direction" text NOT NULL,
	"price_change_logged" integer DEFAULT 0 NOT NULL,
	"pricing_cohort" text NOT NULL,
	"built_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "query_log_ran_at_idx" ON "query_log" USING btree ("ran_at");--> statement-breakpoint
CREATE INDEX "seal_tier_change_events_sub_idx" ON "seal_tier_change_events" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "seal_tier_change_events_at_idx" ON "seal_tier_change_events" USING btree ("changed_at");