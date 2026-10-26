-- Footage is identified by Dropbox file ID from here on, so a moved or renamed
-- clip keeps its row. The path stops being the key because it changes on a
-- move. Existing rows get their ID from the next sync, which adopts each by
-- path (or by rev) and removes the ones no file claims.
ALTER TABLE "footage" DROP CONSTRAINT "footage_pkey";--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "dropbox_id" text;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "footage_path_idx" ON "footage" USING btree ("path");--> statement-breakpoint
ALTER TABLE "footage" ADD CONSTRAINT "footage_dropbox_id_unique" UNIQUE("dropbox_id");
