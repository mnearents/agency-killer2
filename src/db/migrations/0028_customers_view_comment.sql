-- One phrase in this comment contradicted another, and the wrong one was read.
--
-- It said "lifetime revenue is split into subscription_revenue_cents and
-- one_off_revenue_cents" near the top, and then, correctly, near the bottom:
-- "lifetime_orders and the revenue split are ours over the orders we hold,
-- which begin 2025-07-22."
--
-- Both cannot be true. The `high_value` segment was written against the first
-- and ranked fourteen months of a three-year history: $512k against a real
-- $3.7m, and a top customer of $463 against a real $6,885 (#76).
--
-- The fix is to stop the word "lifetime" appearing anywhere near those two
-- columns. Nothing else in the comment changes.

COMMENT ON VIEW analytics.customers IS
  'One row per Shopify customer. email, first_name, last_name and raw_json are '
  'excluded — the base table is unreachable by this role. '
  'The derived columns (first_order_at through subscription_status) are a cache '
  'refreshed by the customer sync: NULL means the rollup has never run for that '
  'row, 0 means it ran and found nothing, and derived_at is the only way to tell '
  'them apart — check it before quoting any of them. '
  'subscription_revenue_cents and one_off_revenue_cents are a SPLIT of the '
  'revenue we hold orders for, NOT lifetime totals: they begin 2025-07-22 and '
  'cover about 14% of real lifetime revenue. Use them when the question is '
  'subscription versus one-off. For lifetime spend use shopify_total_spent_cents. '
  'There is deliberately no combined column; add the two only when the question '
  'really is about both, and never call the result lifetime. '
  'is_subscriber and subscription_tier come from Seal, which holds Really '
  'Awesome Doodles only and only the survivors of the most recent of two app '
  'migrations — Shopify subscription apps do not migrate cancelled subscribers, '
  'so Seal has 593 cancellations against a real 15,364. customer_tags is the '
  'authoritative source for lapsed subscribers: inactive_subscriber and '
  'inactive-subscriber (BOTH spellings are in use) minus active-subscriber. '
  'Never define churn from is_subscriber. '
  'first_subscription_order_at and last_subscription_order_at are proxies for '
  'signup and cancellation and are NULL for 85.7% of the lapsed, who churned '
  'before our orders begin. proxy_tenure_days is a floor, never a measurement. '
  'shopify_orders_count and shopify_total_spent_cents are Shopify''s own figures '
  'over all time — 42,982 buyers and $3.7m — while lifetime_orders and the '
  'revenue split are ours over the orders we hold, which begin 2025-07-22 — '
  '8,565 buyers and $512k. Disagreement between them is the size of the history '
  'we are missing, not an error.';
