CREATE TABLE "social_downloads" (
	"id" text PRIMARY KEY NOT NULL,
	"post_id" text NOT NULL,
	"account" text NOT NULL,
	"username" text,
	"called_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"quality" text,
	"rate_limit" integer,
	"rate_remaining" integer,
	"rate_reset_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "social_peers" ADD COLUMN "first_fill_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "social_downloads_called_idx" ON "social_downloads" USING btree ("called_at");--> statement-breakpoint
CREATE INDEX "social_downloads_post_idx" ON "social_downloads" USING btree ("post_id");--> statement-breakpoint
-- @lana.k.social is followed as a teacher; her first fill starts now.
INSERT INTO "social_peers" ("username", "purpose", "active", "notes", "added_by", "first_fill_at")
VALUES ('lana.k.social', 'teacher', 1, 'Instagram growth advice', 'migration', now())
ON CONFLICT ("username") DO UPDATE SET "purpose" = 'teacher', "first_fill_at" = COALESCE("social_peers"."first_fill_at", now());--> statement-breakpoint
UPDATE "social_peers" SET "first_fill_at" = now() WHERE "purpose" = 'teacher' AND "first_fill_at" IS NULL;
