-- Restrict analytics.shopify_inventory to stock that physically exists.
--
-- Merge order note: 0016 (#29), 0017 (#33) and 0018 (#37) are open PRs. This
-- migration touches none of their objects and can be applied in any order
-- relative to them; it only replaces a view created in 0015.
--
-- The view was an unfiltered passthrough of public.shopify_inventory. Two
-- separate distortions rode along with that, and the second is the dangerous
-- one because it produces a plausible number rather than an absurd one.
--
--   1. Retired products are still returned by Shopify, so the sync never
--      prunes them. As of 2026-09-08 that is 235 ARCHIVED and 28 UNLISTED
--      variants alongside 232 ACTIVE ones. Where a product was replaced
--      rather than deleted, its stock is counted twice: the seven retired
--      BAGHLLWN2023 quantity-break variants sum to 1,927 and the ACTIVE
--      product that replaced them holds the real 796, for a total of 2,723.
--
--   2. Untracked variants — digital goods, gift cards, shipping-protection
--      and return products — carry a quantity Shopify never maintains. Some
--      are sentinels (four `x-redo` rows at 1,000,000, 999,997 and 999,792);
--      most are unbounded negatives accumulated from sales against stock that
--      was never counted. ACTIVE untracked variants summed to -21,097.
--
-- Filtering only on status looks like a fix and is not: it returns 8,398
-- units, which is 29,495 of real stock plus -21,097 of noise. That number is
-- wrong and reads as reasonable, which is worse than 3,687,700 reading as
-- obviously broken. Both predicates are required, so both live here rather
-- than in whatever query gets written next.
--
-- The domain path was never affected: classifyItem already ignores anything
-- non-ACTIVE or untracked, so inventory_status and the Slack alerts were
-- correct throughout. This closes the same gap for raw SQL through the MCP
-- query tool, which bypasses that code entirely.

DROP VIEW IF EXISTS analytics.shopify_inventory CASCADE;
CREATE VIEW analytics.shopify_inventory AS
SELECT i.id, i.product_id, i.product_title, i.variant_title, i.sku,
       i.quantity, i.tracked, i.product_status, i.product_type,
       i.price_cents, i.synced_at
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
  'and treat quantity as meaningless wherever tracked = 0.';

-- Redundant while 0015's ALTER DEFAULT PRIVILEGES holds, which it does — the
-- recreated view came back granted under test. Stated anyway so the migration
-- does not depend on an invisible database-level setting being intact: the
-- failure mode is DROP ... CASCADE removing the grant and the query tool
-- losing this table with no error anywhere.
GRANT SELECT ON analytics.shopify_inventory TO claude_readonly;
