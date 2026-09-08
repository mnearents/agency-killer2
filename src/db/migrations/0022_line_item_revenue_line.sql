-- Classify line items that have no product behind them, so a revenue split
-- stops silently booking them as product revenue.
--
-- 137 of 58,558 line items ($2,829.73) carry no variant_id, no product_id and
-- no sku. They are custom lines typed straight onto an order, and they are not
-- one thing:
--
--   what                              rows      value
--   ------------------------------------------------
--   RAD Studio upgrades / prorations    79   $1,908.11
--   test data                           48     $716.12
--   gift subscriptions                   6     $250.30
--   Faire marketplace fees               3     -$44.80
--   Faire commission at zero             1       $0.00
--
-- The rule is keyed on all three id columns being absent rather than on
-- variant_id alone. One real product ("Coloring Tie Fabric Markers", type
-- "Markers", $6) has a null variant_id but a populated product_id and type,
-- and the looser key books it as non-product.
--
-- Nothing here reads title. Titles are an ongoing feed — "RAD Studio Upgrade:
-- Spark Monthly -> Studio Monthly (june 2026 prorated)" becomes a November
-- title nobody wrote a pattern for, and the row rejoins product revenue with
-- no error anywhere.
--
-- Only one subtype is structurally derivable: marketplace fees are the
-- negative-value lines, and all 3 negative line items in the table are Faire.
-- A fourth Faire commission line is booked at $0 and therefore lands in
-- `unclassified` — it moves no money, so widening the rule to catch it would
-- also sweep in the $0 test row and buy nothing.
--
-- Test data is NOT derivable and is left in `unclassified` deliberately. See
-- the non_product_kind comment.
--
-- Consequence, accepted: $1,908.11 of Studio upgrade revenue sits outside the
-- subscription line. That is 0.7% of subscription revenue, and it is visible
-- as `unclassified` rather than absorbed. The alternative rule would import
-- $716.12 of test data into subscription revenue permanently.

DROP VIEW IF EXISTS analytics.shopify_line_items CASCADE;--> statement-breakpoint
CREATE VIEW analytics.shopify_line_items AS
SELECT l.id, l.order_id, l.product_id, l.variant_id, l.product_type,
       l.sku, l.title, l.variant_title, l.vendor, l.quantity, l.price_cents,
       l.total_discount_cents, l.requires_shipping,
       -- Net of discount, in cents. Null when the discount was never fetched,
       -- so an un-backfilled row reads as unknown rather than as gross.
       (l.quantity * l.price_cents) - l.total_discount_cents AS net_revenue_cents,
       CASE
         WHEN l.variant_id IS NULL AND l.product_id IS NULL AND l.sku IS NULL
           THEN 'non_product'
         ELSE 'product'
       END AS revenue_line,
       CASE
         WHEN l.variant_id IS NOT NULL OR l.product_id IS NOT NULL
              OR l.sku IS NOT NULL THEN NULL
         WHEN l.price_cents < 0 THEN 'marketplace_fee'
         ELSE 'unclassified'
       END AS non_product_kind
FROM public.shopify_line_items l;--> statement-breakpoint

COMMENT ON COLUMN analytics.shopify_line_items.revenue_line IS
  'product where the row has a variant_id, product_id or sku behind it, '
  'non_product where it has none of the three. Split revenue on this before '
  'splitting on product_type — the 137 non_product rows are subscription '
  'upgrades, test data, gift subscriptions and marketplace fees, and they '
  'belong in no product revenue line. non_product is a holding line, not a '
  'revenue category. It leaves $1,908.11 of RAD Studio upgrade '
  'revenue outside the subscription line, which is 0.7% of subscription '
  'revenue and is a deliberate omission rather than a gap. Booking it would '
  'require a title pattern, and a title pattern over an ongoing feed fails '
  'silently the first month someone words an upgrade differently.';--> statement-breakpoint

COMMENT ON COLUMN analytics.shopify_line_items.non_product_kind IS
  'Subtype within revenue_line = non_product, null elsewhere. marketplace_fee '
  'is the negative-value lines, all 3 of which are Faire commission and Faire '
  'payment processing fees totalling -$44.80. unclassified is everything else '
  'and is NOT clean: it holds 48 test rows worth $716.12, titled '
  'variations on Color Happy Test Variants, DO NOT BUY and asdf, alongside 79 '
  'genuine Studio upgrade lines worth $1,908.11, 6 gift subscriptions worth '
  '$250.30 and one Faire commission booked at $0. Read it as work '
  'outstanding, never as a category. Test data has no structural marker on '
  'the Shopify side: shopify_orders carries no email, raw_json.customer holds '
  'only an id, and the test- tags in Seal are marketing cohort tags rather '
  'than account markers — test-th alone is on 42,107 of 54,225 orders, so '
  'reading them as a test flag would discard three quarters of revenue. The '
  'fix is a real tag on the internal accounts in Shopify admin, after which '
  'a test subtype can be derived here.';--> statement-breakpoint

GRANT SELECT ON analytics.shopify_line_items TO claude_readonly;
