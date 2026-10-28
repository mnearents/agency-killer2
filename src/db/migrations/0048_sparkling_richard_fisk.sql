CREATE TABLE "meta_watch_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"object_id" text NOT NULL,
	"object_name" text NOT NULL,
	"campaign_id" text,
	"field" text,
	"before" text,
	"after" text
);
--> statement-breakpoint
CREATE TABLE "meta_watch_objects" (
	"id" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"name" text NOT NULL,
	"campaign_id" text,
	"adset_id" text,
	"status" text,
	"effective_status" text,
	"daily_budget_cents" bigint,
	"lifetime_budget_cents" bigint,
	"bid_strategy" text,
	"spend_cap_cents" bigint,
	"creative_id" text,
	"created_time" text,
	"updated_time" text,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "meta_watch_changes_detected_idx" ON "meta_watch_changes" USING btree ("detected_at");