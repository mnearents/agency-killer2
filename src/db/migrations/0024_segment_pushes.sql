CREATE TABLE "segment_push_members" (
	"push_id" text NOT NULL,
	"email" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment_pushes" (
	"id" text PRIMARY KEY NOT NULL,
	"segment_id" text NOT NULL,
	"external_id" text NOT NULL,
	"dry_run" integer NOT NULL,
	"plan_token" text NOT NULL,
	"added_count" integer NOT NULL,
	"removed_count" integer NOT NULL,
	"unchanged_count" integer NOT NULL,
	"reachable_checked" integer,
	"reachable_eligible" integer,
	"batch_job_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"records_succeeded" integer,
	"records_failed" integer,
	"problem" text,
	"pushed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "segment_push_members_push_idx" ON "segment_push_members" USING btree ("push_id");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_push_members_unique" ON "segment_push_members" USING btree ("push_id","email");--> statement-breakpoint
CREATE INDEX "segment_pushes_segment_idx" ON "segment_pushes" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "segment_pushes_created_idx" ON "segment_pushes" USING btree ("created_at");