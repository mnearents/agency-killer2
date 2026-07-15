CREATE TABLE "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"category" text NOT NULL,
	"subcategory" text,
	"source_file" text,
	"content_hash" text NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"total_chunks" integer DEFAULT 1 NOT NULL,
	"context_prefix" text NOT NULL,
	"document_date" timestamp with time zone,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_adsets" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"targeting" jsonb,
	"optimization_goal" text,
	"billing_event" text,
	"bid_strategy" text,
	"daily_budget_cents" integer,
	"lifetime_budget_cents" integer,
	"start_time" timestamp with time zone,
	"stop_time" timestamp with time zone,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_ads" (
	"id" text PRIMARY KEY NOT NULL,
	"adset_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"creative_id" text,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"objective" text,
	"buying_type" text,
	"daily_budget_cents" integer,
	"lifetime_budget_cents" integer,
	"start_time" timestamp with time zone,
	"stop_time" timestamp with time zone,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_creatives" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"title" text,
	"body" text,
	"image_url" text,
	"video_url" text,
	"call_to_action_type" text,
	"object_type" text,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meta_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"ad_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	"adset_id" text NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"impressions" bigint DEFAULT 0 NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"reach" bigint DEFAULT 0 NOT NULL,
	"cpm" real,
	"cpc" real,
	"ctr" real,
	"purchases" integer DEFAULT 0 NOT NULL,
	"purchase_value_cents" integer DEFAULT 0 NOT NULL,
	"add_to_cart" integer DEFAULT 0 NOT NULL,
	"initiate_checkout" integer DEFAULT 0 NOT NULL,
	"publisher_platform" text,
	"platform_position" text,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text,
	"variant_id" text,
	"product_type" text,
	"sku" text,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"price_cents" bigint NOT NULL,
	"raw_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "shopify_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"total_price_cents" bigint NOT NULL,
	"subtotal_price_cents" bigint,
	"total_tax_cents" bigint,
	"total_discounts_cents" bigint,
	"financial_status" text,
	"fulfillment_status" text,
	"customer_id" text,
	"source_name" text,
	"referring_site" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"is_recurring" integer DEFAULT 0 NOT NULL,
	"tags" jsonb,
	"discount_codes" jsonb,
	"order_created_at" timestamp with time zone,
	"raw_json" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_adsets" ADD CONSTRAINT "meta_adsets_campaign_id_meta_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."meta_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_ads" ADD CONSTRAINT "meta_ads_adset_id_meta_adsets_id_fk" FOREIGN KEY ("adset_id") REFERENCES "public"."meta_adsets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meta_ads" ADD CONSTRAINT "meta_ads_campaign_id_meta_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."meta_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_line_items" ADD CONSTRAINT "shopify_line_items_order_id_shopify_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."shopify_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_documents_category_idx" ON "kb_documents" USING btree ("category");--> statement-breakpoint
CREATE INDEX "kb_documents_source_idx" ON "kb_documents" USING btree ("source_file");--> statement-breakpoint
CREATE INDEX "kb_documents_hash_idx" ON "kb_documents" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_insights_dedup_idx" ON "meta_insights" USING btree ("ad_id","date","publisher_platform","platform_position");--> statement-breakpoint
CREATE INDEX "meta_insights_date_idx" ON "meta_insights" USING btree ("date");--> statement-breakpoint
CREATE INDEX "meta_insights_campaign_idx" ON "meta_insights" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "meta_insights_ad_idx" ON "meta_insights" USING btree ("ad_id");--> statement-breakpoint
CREATE INDEX "shopify_line_items_product_idx" ON "shopify_line_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "shopify_orders_created_idx" ON "shopify_orders" USING btree ("order_created_at");--> statement-breakpoint
CREATE INDEX "shopify_orders_customer_idx" ON "shopify_orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "shopify_orders_utm_idx" ON "shopify_orders" USING btree ("utm_source","utm_medium","utm_campaign");