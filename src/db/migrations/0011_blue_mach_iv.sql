CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task" text NOT NULL,
	"outcome" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"error_code" integer,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_insights" ALTER COLUMN "reach" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "meta_insights" ALTER COLUMN "reach" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_insights" ADD COLUMN "frequency" real;--> statement-breakpoint
ALTER TABLE "meta_insights" ADD COLUMN "cpp" real;--> statement-breakpoint
ALTER TABLE "meta_insights" ADD COLUMN "attribution_window" text DEFAULT '7d_click' NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_runs_task_started_idx" ON "sync_runs" USING btree ("task","started_at");--> statement-breakpoint
CREATE INDEX "sync_runs_task_window_idx" ON "sync_runs" USING btree ("task","window_start");