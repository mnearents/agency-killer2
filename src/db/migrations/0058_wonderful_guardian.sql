ALTER TABLE "social_post_visuals" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "social_post_visuals" ADD COLUMN "song_used" text;--> statement-breakpoint
ALTER TABLE "social_post_visuals" ADD COLUMN "audio_note" text;--> statement-breakpoint
ALTER TABLE "social_posts" ADD COLUMN "visual_status" text;--> statement-breakpoint
-- What the visual analysis has already found.
UPDATE "social_post_visuals" SET "source" = 'api' WHERE "source" IS NULL;--> statement-breakpoint
UPDATE "social_posts" SET "visual_status" = 'cover_only' WHERE "id" IN (SELECT "post_id" FROM "social_post_visuals" WHERE "account" = 'own' AND "basis" = 'cover');--> statement-breakpoint
UPDATE "social_posts" SET "visual_status" = 'analyzed' WHERE "id" IN (SELECT "post_id" FROM "social_post_visuals" WHERE "account" = 'own' AND "basis" = 'frames' AND "status" = 'ok');
