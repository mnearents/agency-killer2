CREATE TABLE "product_strategy" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"role" text,
	"audiences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"season_start_month" integer,
	"season_end_month" integer,
	"priority_rank" integer,
	"notes" text,
	"author" text NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "product_strategy_product_created_idx" ON "product_strategy" USING btree ("product_id","created_at");