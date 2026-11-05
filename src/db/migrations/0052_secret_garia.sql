ALTER TABLE "shopify_orders" ADD COLUMN "landing_page" text;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "landing_path" text;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "journey_source" text;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "journey_source_type" text;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "last_landing_path" text;--> statement-breakpoint
ALTER TABLE "shopify_orders" ADD COLUMN "journey_ready" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 5b: an order carrying a Subscription product is a subscription order. The
-- sync now says so for new and re-synced orders; this applies the same rule
-- to every order already stored. Renewals billed by the pre-Seal app carry the
-- plan but not the "recurring-order" tag, so they sat in is_recurring = 0 at
-- renewal prices and read as one-off product orders.
UPDATE "shopify_orders" o
SET "is_recurring" = 1
WHERE o."is_recurring" = 0
  AND EXISTS (
    SELECT 1 FROM "shopify_line_items" li
    WHERE li."order_id" = o."id" AND li."product_type" = 'Subscription'
  );
