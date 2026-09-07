ALTER TABLE "shopify_line_items" ADD COLUMN "variant_title" text;--> statement-breakpoint
ALTER TABLE "shopify_line_items" ADD COLUMN "vendor" text;--> statement-breakpoint
ALTER TABLE "shopify_line_items" ADD COLUMN "total_discount_cents" bigint;--> statement-breakpoint
ALTER TABLE "shopify_line_items" ADD COLUMN "requires_shipping" integer;--> statement-breakpoint

-- Re-expose the line items view with the new columns. Without this the
-- backfilled data is unreachable from the analytics role, which is the only
-- way anyone actually queries it.
DROP VIEW IF EXISTS analytics.shopify_line_items CASCADE;--> statement-breakpoint
CREATE VIEW analytics.shopify_line_items AS
SELECT l.id, l.order_id, l.product_id, l.variant_id, l.product_type,
       l.sku, l.title, l.variant_title, l.vendor, l.quantity, l.price_cents,
       l.total_discount_cents, l.requires_shipping,
       -- Net of discount, in cents. Null when the discount was never fetched,
       -- so an un-backfilled row reads as unknown rather than as gross.
       (l.quantity * l.price_cents) - l.total_discount_cents AS net_revenue_cents
FROM public.shopify_line_items l;--> statement-breakpoint
GRANT SELECT ON analytics.shopify_line_items TO claude_readonly;