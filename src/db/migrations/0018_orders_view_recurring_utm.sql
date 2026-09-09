-- analytics.shopify_orders: mark the trustworthy half of is_recurring, and drop
-- the attribution columns that are empty on every row.
--
-- DISTORTION 1 — is_recurring undercounts before 2026-06-01.
--
-- Subscription renewals bill on the 1st of the month and always have. Total
-- orders on the 1st are steady at ~3,100-3,600 back through 2025-09. What
-- changed is how many of them carried the flag:
--
--   date        total   is_recurring=1   unflagged
--   2025-09-01   3636       2069           1567
--   2025-11-01   2516        917           1599
--   2026-01-01   3446        348           3098
--   2026-05-01   3153       1033           2120
--   2026-06-01   3505       3439             66
--   2026-08-01   3102       3098              4
--
-- The pre-June gap is not a ramp, it is noise: renewals processed by the
-- pre-Seal subscription app were never flagged, and the share that was flagged
-- swung between 10% and 60% month to month. From the 2026-06-01 billing cycle
-- — the first full cycle after the Seal migration — coverage is effectively
-- complete.
--
-- The damage runs the other way. Those unflagged renewals land in
-- is_recurring = 0 at roughly $5.50 a piece, which is a renewal price, not a
-- product order. They drag "one-off" AOV to $9.92 in January against $31.59 in
-- June. Any figure computed from is_recurring = 0 over pre-June data is a
-- subscription-contaminated number that still looks like a product number,
-- which is the dangerous kind of wrong.
--
-- is_recurring_reliable does not say whether an order is a renewal. It says
-- whether this row's is_recurring value can be believed. Filter on it before
-- splitting subscription from product revenue.
--
-- DISTORTION 2 — the attribution columns are empty, not sparse.
--
-- Across all 54,225 orders: utm_source, utm_medium, utm_campaign, utm_content,
-- utm_term and referring_site are non-null on ZERO rows. The Shopify sync never
-- requested them, and raw_json holds no customerJourneySummary, landingSite or
-- referringSite either, so this is not recoverable retroactively — the history
-- does not exist to backfill. Six columns shaped like an attribution path and
-- carrying nothing is a trap for whoever writes the next query, so they are
-- removed from the view rather than left to be discovered empty.
--
-- source_name is kept because it is not empty, but it is not a channel: 11 rows
-- carry Amazon and marketplace ORDER IDENTIFIERS ("114-6042741-0940223"), and
-- the other 54,214 are null. Do not read it as a traffic source.

DROP VIEW IF EXISTS analytics.shopify_orders CASCADE;

CREATE VIEW analytics.shopify_orders AS
SELECT
  o.id,
  o.order_number,
  o.currency,
  o.total_price_cents,
  o.subtotal_price_cents,
  o.total_tax_cents,
  o.total_discounts_cents,
  o.financial_status,
  o.fulfillment_status,
  -- Stored as a GID ("gid://shopify/Customer/12345"). Resolved to the bare id
  -- here so the bridge to analytics.subscriptions.customer_id is a plain
  -- equality join and nobody re-derives it per query.
  NULLIF(split_part(o.customer_id, '/', 5), '') AS customer_id,
  o.customer_id AS customer_gid,
  o.source_name,
  o.is_recurring,
  -- 1 where is_recurring can be believed, 0 where it undercounts. See header.
  CASE WHEN o.order_created_at >= '2026-06-01' THEN 1 ELSE 0 END
    AS is_recurring_reliable,
  o.tags,
  o.discount_codes,
  o.order_created_at,
  o.synced_at
FROM public.shopify_orders o;

COMMENT ON COLUMN analytics.shopify_orders.is_recurring_reliable IS
  '1 where is_recurring can be believed, 0 where it undercounts. The boundary '
  'is 2026-06-01, and that date is a genuine billing day rather than a '
  'migration dump — renewals have billed on the 1st all along, with total '
  'orders on the 1st steady at 3,100-3,600 back through 2025-09. Only flag '
  'coverage moved, and it moved erratically: 2,069 flagged in September, 917 '
  'in November, 348 in January, before going effectively complete from the '
  'first full billing cycle after the Seal migration. It is therefore not a '
  'date to nudge when a number looks wrong. Before it, unflagged renewals sit '
  'in is_recurring = 0 at about $5.50 each. After it, 4 of 3,102 orders on a '
  'billing day are unflagged.';

COMMENT ON VIEW analytics.shopify_orders IS
  'One row per Shopify order. raw_json excluded — it carries the full customer '
  'and shipping payload. customer_id is the bare numeric id, already extracted '
  'from the GID, and joins directly to analytics.subscriptions.customer_id. '
  'is_recurring UNDERCOUNTS before 2026-06-01: renewals from the pre-Seal '
  'subscription app were never flagged, so 1,500-3,100 renewals a month sit in '
  'is_recurring = 0 at about $5.50 each and depress product AOV wherever they '
  'are read as one-off orders. Filter is_recurring_reliable = 1 before '
  'splitting subscription from product revenue. It marks whether the flag can '
  'be trusted, not whether the order recurs. The utm_source, utm_medium, '
  'utm_campaign, utm_content, utm_term and referring_site columns are omitted '
  'because they are null on all 54,225 orders and cannot be backfilled — the '
  'sync never requested them. source_name is not a channel: the 11 non-null '
  'values are Amazon and marketplace order identifiers.';

GRANT SELECT ON analytics.shopify_orders TO claude_readonly;
