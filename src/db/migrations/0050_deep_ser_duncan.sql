CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period" text NOT NULL,
	"line" text,
	"target_cents" bigint,
	"priorities" jsonb,
	"notes" text,
	"author" text NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "goals_kind_period_line_created_idx" ON "goals" USING btree ("kind","period","line","created_at");--> statement-breakpoint
-- The 2027 target as Matt set it in the brief of 2026-11-05: $1M in revenue,
-- profitably. Monthly targets by line are his to set with goals_set.
INSERT INTO "goals" ("id", "kind", "period", "line", "target_cents", "notes", "author")
VALUES (gen_random_uuid()::text, 'target', '2027', 'total', 100000000, '$1M revenue in 2027, profitably.', 'Matt');
