CREATE TABLE "calendar_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"notes" text,
	"ai_suggested" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "calendar_entries_date_idx" ON "calendar_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "calendar_entries_channel_idx" ON "calendar_entries" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "calendar_entries_status_idx" ON "calendar_entries" USING btree ("status");