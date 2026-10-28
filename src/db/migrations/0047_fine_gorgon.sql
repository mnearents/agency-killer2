-- Finished ads (/RAD/Footage/Finished Ads) are kept apart from raw footage.
-- Every existing row starts as `raw`; the next sync finds the ones in that
-- folder, sees the kind changed, and analyses them as ads.
ALTER TABLE "footage" ADD COLUMN "kind" text DEFAULT 'raw' NOT NULL;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "ad_hook" text;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "ad_angle" text;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "ad_product" text;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "ad_call_to_action" text;--> statement-breakpoint
ALTER TABLE "footage" ADD COLUMN "ad_format" text;--> statement-breakpoint
CREATE INDEX "footage_kind_idx" ON "footage" USING btree ("kind");