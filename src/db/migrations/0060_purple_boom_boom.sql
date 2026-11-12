CREATE TABLE "social_lesson_runs" (
	"post_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"basis" text,
	"lesson_count" integer,
	"detail" text,
	"analysed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"username" text NOT NULL,
	"area" text NOT NULL,
	"principle" text NOT NULL,
	"how_to_apply" text,
	"kind" text NOT NULL,
	"quote" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "social_peers" ADD COLUMN "purpose" text DEFAULT 'peer' NOT NULL;--> statement-breakpoint
CREATE INDEX "social_lessons_post_idx" ON "social_lessons" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "social_lessons_user_idx" ON "social_lessons" USING btree ("username");