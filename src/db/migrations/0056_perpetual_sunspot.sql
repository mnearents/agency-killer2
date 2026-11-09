CREATE TABLE "social_peer_days" (
	"username" text NOT NULL,
	"day" date NOT NULL,
	"name" text,
	"followers_count" integer NOT NULL,
	"media_count" integer NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_peer_posts" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"caption" text,
	"media_type" text NOT NULL,
	"media_product_type" text,
	"permalink" text,
	"thumbnail_url" text,
	"like_count" integer,
	"comments_count" integer,
	"view_count" integer,
	"posted_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_peers" (
	"username" text PRIMARY KEY NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_reviews" ADD COLUMN "from_peers" text;--> statement-breakpoint
CREATE UNIQUE INDEX "social_peer_days_user_day_idx" ON "social_peer_days" USING btree ("username","day");--> statement-breakpoint
CREATE INDEX "social_peer_posts_user_posted_idx" ON "social_peer_posts" USING btree ("username","posted_at");--> statement-breakpoint
-- The first peer, asked for by Matt on 2026-11-09.
INSERT INTO "social_peers" ("username", "notes", "added_by") VALUES ('pippipost.shop', 'Pippi Post — bookish merch and reader gifts', 'Matt') ON CONFLICT DO NOTHING;
