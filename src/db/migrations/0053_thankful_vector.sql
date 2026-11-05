CREATE TABLE "ad_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"concept" text,
	"hook_text" text,
	"body" text,
	"format" text,
	"meta_ad_name" text,
	"meta_ad_id" text,
	"finished_ad_dropbox_id" text,
	"notes" text,
	"author" text NOT NULL,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ad_assets_meta_ad_id_idx" ON "ad_assets" USING btree ("meta_ad_id");--> statement-breakpoint
CREATE INDEX "ad_assets_meta_ad_name_idx" ON "ad_assets" USING btree ("meta_ad_name");