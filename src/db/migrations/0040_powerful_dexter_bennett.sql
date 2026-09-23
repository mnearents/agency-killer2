CREATE TABLE "shopify_products" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"handle" text NOT NULL,
	"status" text NOT NULL,
	"product_type" text,
	"vendor" text,
	"tags" jsonb,
	"description_html" text,
	"seo_title" text,
	"seo_description" text,
	"metafields" jsonb,
	"product_updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_products_handle_idx" ON "shopify_products" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "shopify_products_status_idx" ON "shopify_products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "shopify_products_type_idx" ON "shopify_products" USING btree ("product_type");