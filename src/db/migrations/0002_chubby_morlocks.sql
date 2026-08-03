CREATE TABLE "social_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"ig_user_id" text NOT NULL,
	"caption" text,
	"media_type" text NOT NULL,
	"media_product_type" text,
	"permalink" text,
	"thumbnail_url" text,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comments_count" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"reach" integer DEFAULT 0 NOT NULL,
	"saved" integer DEFAULT 0 NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"plays" integer DEFAULT 0 NOT NULL,
	"total_interactions" integer DEFAULT 0 NOT NULL,
	"posted_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "social_posts_posted_idx" ON "social_posts" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "social_posts_media_type_idx" ON "social_posts" USING btree ("media_type");--> statement-breakpoint
CREATE INDEX "social_posts_ig_user_idx" ON "social_posts" USING btree ("ig_user_id");