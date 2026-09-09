-- Record the Shopify InventoryItem id against each variant.
--
-- Depends on 0019 — it recreates the view that migration filtered, so applying
-- these out of order would restore the unfiltered passthrough.
--
-- Several variants can point at one InventoryItem, in which case they sell the
-- same physical units and summing their quantities counts that stock once per
-- variant. That is the #9 failure: seven BAGHLLWN2023 quantity-break variants
-- reporting 1,927 units for 796 real ones. A Mechanic app used to keep them in
-- step and was uninstalled with nothing replacing it.
--
-- Until now the identity of the pool was not recorded anywhere — not as a
-- column, and not in raw_json, because INVENTORY_QUERY asked only for
-- `inventoryItem { tracked }`. The only way to group variants was a regex over
-- the title, which #9 ruled out as inference dressed up as data.
--
-- Nullable and backfill-free on purpose. Shopify is the source of truth and
-- the next inventory sync populates every row; inventing values here would put
-- a guess where the detection check expects an observation.

ALTER TABLE "shopify_inventory" ADD COLUMN IF NOT EXISTS "inventory_item_id" text;

CREATE INDEX IF NOT EXISTS "shopify_inventory_item_idx"
  ON "shopify_inventory" ("inventory_item_id");

COMMENT ON COLUMN "shopify_inventory"."inventory_item_id" IS
  'Shopify InventoryItem GID — the stock pool, not the variant. Two rows '
  'sharing one value sell the same physical units; SUM(quantity) across them '
  'double counts. Null until the first sync after this migration, and null '
  'for variants Shopify returns without an inventoryItem.';

-- Recreated so the new column is reachable from the query tool, which is where
-- the pool grouping would actually be run. Both 0019 predicates are repeated
-- here deliberately; dropping either reintroduces the distortions that
-- migration documents.
DROP VIEW IF EXISTS analytics.shopify_inventory CASCADE;
CREATE VIEW analytics.shopify_inventory AS
SELECT i.id, i.product_id, i.product_title, i.variant_title, i.sku,
       i.quantity, i.tracked, i.inventory_item_id, i.product_status,
       i.product_type, i.price_cents, i.synced_at
FROM public.shopify_inventory i
WHERE i.product_status = 'ACTIVE'
  AND i.tracked = 1;

COMMENT ON VIEW analytics.shopify_inventory IS
  'Sellable, stock-tracked variants only — this is a filtered view, not the '
  'whole table. Two exclusions, both load-bearing. Non-ACTIVE products are '
  'excluded because Shopify keeps returning retired variants and the sync '
  'never prunes them, so a product replaced rather than deleted has its stock '
  'counted twice (BAGHLLWN2023: 1,927 retired plus the real 796). Untracked '
  'variants are excluded because Shopify does not maintain their quantity: '
  'digital goods, gift cards and shipping-protection products carry sentinel '
  'values near 1,000,000 or unbounded negatives, and ACTIVE untracked stock '
  'summed to -21,097 on 2026-09-08. Filtering on status alone is NOT '
  'sufficient — it yields a plausible-looking 8,398 against a true 29,495. '
  'Consequence of the second filter: digital and gift-card products are absent '
  'here entirely. This view answers "how much physical stock is there", not '
  '"what is in the catalogue" — for the latter query public.shopify_inventory '
  'and treat quantity as meaningless wherever tracked = 0. '
  'inventory_item_id is the stock pool: GROUP BY it to find variants that '
  'share units, and never SUM(quantity) across a group that shares one.';

GRANT SELECT ON analytics.shopify_inventory TO claude_readonly;
