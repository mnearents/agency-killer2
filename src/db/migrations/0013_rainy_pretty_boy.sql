CREATE TABLE "pilot_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"category" text,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pilot_notes_note_idx" ON "pilot_notes" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "pilot_notes_created_idx" ON "pilot_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "pilot_notes_category_idx" ON "pilot_notes" USING btree ("category");