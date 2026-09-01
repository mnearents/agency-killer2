CREATE TABLE "shopify_inventory" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text,
	"product_title" text NOT NULL,
	"variant_title" text,
	"sku" text,
	"quantity" integer NOT NULL,
	"tracked" integer NOT NULL,
	"product_status" text NOT NULL,
	"product_type" text,
	"price_cents" bigint NOT NULL,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shopify_inventory_product_idx" ON "shopify_inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "shopify_inventory_status_idx" ON "shopify_inventory" USING btree ("product_status");