CREATE TABLE "teacher_videos" (
	"id" text PRIMARY KEY NOT NULL,
	"shortcode" text NOT NULL,
	"url" text NOT NULL,
	"username" text,
	"caption" text,
	"note" text,
	"saved_by" text,
	"saved_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"detail" text,
	"transcript" text,
	"opening_words" text,
	"duration_ms" integer,
	"read_at" timestamp with time zone,
	CONSTRAINT "teacher_videos_shortcode_unique" UNIQUE("shortcode")
);
--> statement-breakpoint
-- Teachers are no longer followed: videos are sent one at a time. The
-- accounts stop being read; everything collected from them is kept.
UPDATE "social_peers" SET "active" = 0, "updated_at" = now() WHERE "purpose" = 'teacher' AND "active" = 1;
