-- Expose unit cost and weight on analytics.shopify_inventory.
--
-- `unit_cost_cents` has been synced all along and was simply not in the view,
-- so no column matching '%cost%' existed anywhere in the analytics schema and
-- margin was unanswerable from SQL. `unit_economics` computed landed cost
-- internally and reported it, which made the data look present while being
-- unreachable.
--
-- Weight is new. Postage is now USPS Media Mail — no zones, no dimensional
-- weight — so the rate is a pure function of pounds, which makes weight a
-- direct input to per-SKU contribution and to whether two products can be
-- bundled without crossing a rate band.
--
-- COVERAGE IS PARTIAL AND THE NUMBERS BELOW ARE FLOORS. 133 of 535 variants
-- carry a cost. That figure is misleading on its own: it counts digital and
-- archived variants that will never have one. Among ACTIVE tracked SKUs —
-- the population a pricing decision is about — coverage runs 69-86%, and is
-- HIGHER on slow movers than fast ones. Any margin computed here is therefore
-- a floor over the SKUs that have a cost, never a catalogue-wide figure.
DROP VIEW IF EXISTS analytics.shopify_inventory CASCADE;

CREATE VIEW analytics.shopify_inventory AS
SELECT
  i.id,
  i.product_id,
  i.product_title,
  i.variant_title,
  i.sku,
  i.quantity,
  i.tracked,
  i.inventory_item_id,
  i.product_status,
  i.product_type,
  i.price_cents,
  -- NULL means no cost recorded, never zero. A digital product legitimately
  -- costs nothing and a planner nobody costed does not, and collapsing them
  -- is the #91 failure.
  i.unit_cost_cents,
  CASE
    WHEN i.unit_cost_cents IS NOT NULL AND i.price_cents > 0
    THEN ROUND(((i.price_cents - i.unit_cost_cents)::numeric / i.price_cents), 4)
  END AS gross_margin_rate,
  i.weight_value,
  i.weight_unit,
  -- Normalised. The catalogue mixes GRAMS, POUNDS and OUNCES, so weight_value
  -- alone cannot be compared across two rows. NULL where the unit was not one
  -- we map, rather than a guess.
  i.weight_lb,
  i.synced_at
FROM public.shopify_inventory i
-- Both filters are inherited deliberately and must not be dropped: a non-ACTIVE
-- product is retired stock that would be counted twice, and an untracked
-- variant reports quantity 0 whatever is really on the shelf. Removing either
-- silently changes every count computed from this view.
WHERE i.product_status = 'ACTIVE'
  AND i.tracked = 1;

COMMENT ON VIEW analytics.shopify_inventory IS
  'One row per ACTIVE, tracked variant. Non-ACTIVE products are retired stock '
  'that would be counted twice, and untracked variants report quantity 0 '
  'whatever is on the shelf, so both are excluded. unit_cost_cents is Shopify "Cost per item" and is NULL '
  'when none is recorded — never 0, which is a real and different answer for a '
  'digital product. COVERAGE IS PARTIAL: 133 of 535 variants carry a cost, but '
  'that counts digital and archived variants that never will. Among ACTIVE '
  'tracked SKUs it runs 69-86%, and is higher on slow movers than fast ones. '
  'Any margin computed from this is a FLOOR over the SKUs that have a cost, not '
  'a catalogue-wide figure — report coverage alongside it. weight_lb is derived '
  'from weight_value and weight_unit, which mix GRAMS, POUNDS and OUNCES across '
  'this catalogue; it is NULL where the unit is unmapped rather than guessed, '
  'and 0 is a real weight for a digital product.';

COMMENT ON COLUMN analytics.shopify_inventory.gross_margin_rate IS
  'Price minus cost over price, 0-1. NULL when no cost is recorded. This is '
  'PRODUCT margin only — it excludes postage, pick and pack, storage, returns '
  'and payment processing, all of which sit in cost of delivery. A SKU at 0.6 '
  'here is not 60% contribution.';
