CREATE TABLE "social_account_days" (
	"ig_user_id" text NOT NULL,
	"day" date NOT NULL,
	"followers_count" integer,
	"followers_captured_at" timestamp with time zone,
	"follows" integer,
	"unfollows" integer,
	"reach" integer,
	"reach_followers" integer,
	"reach_non_followers" integer,
	"views" integer,
	"views_reel" integer,
	"views_post" integer,
	"views_carousel" integer,
	"views_story" integer,
	"views_ad" integer,
	"profile_views" integer,
	"accounts_engaged" integer,
	"insights_fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "social_post_analyses" (
	"post_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"basis" text,
	"summary" text,
	"hook" text,
	"hook_source" text,
	"hook_type" text,
	"topic" text,
	"approach" text,
	"audience" text,
	"product" text,
	"call_to_action" text,
	"detail" text,
	"analysed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_post_snapshots" (
	"post_id" text NOT NULL,
	"captured_on" date NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"age_hours" integer NOT NULL,
	"views" integer,
	"reach" integer NOT NULL,
	"likes" integer NOT NULL,
	"comments" integer NOT NULL,
	"saved" integer NOT NULL,
	"shares" integer NOT NULL,
	"reposts" integer,
	"follows" integer,
	"profile_visits" integer,
	"avg_watch_time_ms" integer,
	"total_interactions" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"week_start" date NOT NULL,
	"week_end" date NOT NULL,
	"headline" text NOT NULL,
	"summary" text NOT NULL,
	"working" text NOT NULL,
	"not_working" text NOT NULL,
	"why" text NOT NULL,
	"try_next" text NOT NULL,
	"author" text NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "views" integer;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "reposts" integer;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "avg_watch_time_ms" integer;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "total_watch_time_ms" bigint;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "follows" integer;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "profile_visits" integer;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "insights_status" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "opening_words" text;--> statement-breakpoint
CREATE UNIQUE INDEX "social_account_days_user_day_idx" ON "social_account_days" USING btree ("ig_user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "social_post_snapshots_post_day_idx" ON "social_post_snapshots" USING btree ("post_id","captured_on");--> statement-breakpoint
CREATE INDEX "social_reviews_week_created_idx" ON "social_reviews" USING btree ("week_start","created_at");