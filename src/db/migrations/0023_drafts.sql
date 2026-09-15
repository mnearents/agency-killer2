CREATE TABLE "draft_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"decision" text NOT NULL,
	"feedback" text DEFAULT '' NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"voice_rules_checked" jsonb NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "draft_decisions_draft_idx" ON "draft_decisions" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "draft_decisions_created_idx" ON "draft_decisions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "drafts_created_idx" ON "drafts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "drafts_type_idx" ON "drafts" USING btree ("type");--> statement-breakpoint
CREATE INDEX "drafts_channel_idx" ON "drafts" USING btree ("channel");