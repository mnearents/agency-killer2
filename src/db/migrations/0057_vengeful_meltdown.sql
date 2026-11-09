CREATE TABLE "social_post_visuals" (
	"post_id" text PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"basis" text,
	"frame_times_ms" jsonb,
	"image_count" integer,
	"summary" text,
	"visual_type" text,
	"hand_drawn" integer,
	"on_screen_text" jsonb,
	"first_frame" text,
	"visual_hook" text,
	"face_in_first_2s" integer,
	"product_visible" integer,
	"product_first_seen" text,
	"setting" text,
	"emotion" text,
	"branding" integer,
	"audio" text,
	"duration_ms" integer,
	"cuts" integer,
	"cuts_per_minute" real,
	"mean_volume_db" real,
	"contact_sheet" "bytea",
	"detail" text,
	"analysed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"metric" text NOT NULL,
	"value" integer,
	"target_date" date,
	"notes" text,
	"author" text NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_peer_posts" ADD COLUMN "image_urls" jsonb;--> statement-breakpoint
ALTER TABLE "social_reviews" ADD COLUMN "ideas_tried" jsonb;--> statement-breakpoint
ALTER TABLE "social_reviews" ADD COLUMN "plan" jsonb;--> statement-breakpoint
CREATE INDEX "social_targets_metric_created_idx" ON "social_targets" USING btree ("metric","created_at");