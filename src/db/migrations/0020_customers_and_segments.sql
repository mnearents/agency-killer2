-- Customers and segments.
--
-- Until now there was no entity representing a person across orders and
-- subscriptions, so every question of the form "who buys this" had no subject.
--
-- PII (email, first_name, last_name) is stored in the base table and excluded
-- from the analytics view, following the structural approach in 0015: base
-- tables are unreachable by claude_readonly and the view is the only way in.
-- Geography stops at city/state/country — analytically useful, not identifying
-- at that granularity. Street address is never synced at all.
--
-- NOTE: this migration assumes 0016_line_item_fields has been applied. It does
-- not depend on the new line-item columns, but the journal must carry both
-- entries in order.

-- ------------------------------------------------------------------ customers
CREATE TABLE IF NOT EXISTS shopify_customers (
  id text PRIMARY KEY,

  -- PII. Excluded from analytics.customers.
  email text,
  first_name text,
  last_name text,

  -- Shopify's own counters, kept ALONGSIDE the derived equivalents rather than
  -- instead of them. When the two disagree it means our order history is
  -- incomplete — a fact worth being able to see rather than one to paper over.
  orders_count integer,
  total_spent_cents bigint,

  -- Shopify's CUSTOMER tags. Named customer_tags, never `tags`, because
  -- shopify_orders.tags is a different thing sharing the name: those are the
  -- product's tags copied onto the order (`homeschool` sits on 42,094 of 54,225
  -- orders) and say nothing about the buyer. These carry subscription lifecycle
  -- state written by the subscription apps and are the authoritative record of
  -- who has lapsed. Two columns called `tags` is how one got read as the other.
  customer_tags jsonb,
  -- Three states. NULL means Shopify reports no consent record at all, which is
  -- not the same as a customer declining; collapsing it to 0 would silently
  -- shrink every marketable audience by an unknown amount.
  accepts_marketing integer,

  city text,
  state text,
  country text,

  customer_created_at timestamptz,

  -- Derived from orders. NULL means the rollup has never run for this row;
  -- 0 means it ran and found nothing. derived_at is what tells them apart.
  first_order_at timestamptz,
  last_order_at timestamptz,
  lifetime_orders integer,
  -- Split, never a single total. A customer worth $25.79 once and a customer
  -- worth $60-180 recurring at near-zero COGS are different businesses, and one
  -- lifetime_revenue number averages them into something describing neither.
  subscription_revenue_cents bigint,
  one_off_revenue_cents bigint,
  product_types_purchased jsonb,

  -- Proxies for signup and cancellation: first and last order containing a
  -- product whose product_type is 'Subscription'. Real subscription dates did
  -- not survive two app migrations, so these are all the lapsed population has.
  -- NULL for 85.7% of them — order history begins 2025-07-22 and they churned
  -- before it — and NULL is the honest answer rather than a reason to fall back
  -- to first_order_at, which would place them in a tenure band computed from a
  -- date unrelated to their subscription.
  first_subscription_order_at timestamptz,
  last_subscription_order_at timestamptz,

  -- Derived from Seal, joined via split_part(id, '/', 5).
  is_subscriber integer,
  subscription_tier text,
  subscription_status text,
  derived_at timestamptz,

  raw_json jsonb,
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shopify_customers_last_order_idx
  ON shopify_customers (last_order_at);
CREATE INDEX IF NOT EXISTS shopify_customers_subscriber_idx
  ON shopify_customers (is_subscriber);
-- GIN, because every lapsed segment is a jsonb containment test over 99,265
-- rows and there are six of them re-evaluated on every customer sync.
CREATE INDEX IF NOT EXISTS shopify_customers_tags_idx
  ON shopify_customers USING gin (customer_tags);
CREATE INDEX IF NOT EXISTS shopify_customers_last_sub_order_idx
  ON shopify_customers (last_subscription_order_at);

-- ------------------------------------------------------------------- segments
CREATE TABLE IF NOT EXISTS segments (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- SQL predicate, evaluated against analytics.customers aliased `c`.
  definition text NOT NULL,
  notes text,
  member_count integer,
  last_evaluated_at timestamptz,
  -- Set when the last evaluation failed, so a stale count is not read as
  -- current. A failed run never advances last_evaluated_at.
  last_evaluation_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- analytics views
DROP VIEW IF EXISTS analytics.customers CASCADE;
CREATE VIEW analytics.customers AS
SELECT
  -- Bare numeric id, matching analytics.shopify_orders.customer_id and
  -- analytics.subscriptions.customer_id so every join is plain equality.
  NULLIF(split_part(c.id, '/', 5), '') AS customer_id,
  c.id AS customer_gid,

  c.orders_count AS shopify_orders_count,
  c.total_spent_cents AS shopify_total_spent_cents,
  c.customer_tags,
  c.accepts_marketing,
  c.city,
  c.state,
  c.country,
  c.customer_created_at,

  c.first_order_at,
  c.last_order_at,
  -- Computed, never stored: a days-since number written to a column would be
  -- wrong the moment a day passed, and a stale number that looks fresh is worse
  -- than a join.
  CASE WHEN c.last_order_at IS NULL THEN NULL
       ELSE EXTRACT(DAY FROM (now() - c.last_order_at))::int
  END AS days_since_last_order,

  c.lifetime_orders,
  c.subscription_revenue_cents,
  c.one_off_revenue_cents,
  c.product_types_purchased,

  c.first_subscription_order_at,
  c.last_subscription_order_at,
  -- Both computed, never stored, for the same reason as days_since_last_order.
  -- The span is a FLOOR on tenure, not a measurement: a customer whose first
  -- subscription order sits at the start of our window was already subscribing
  -- when it opened, and 370 of the 396 in the 12-24m band are exactly that.
  CASE WHEN c.first_subscription_order_at IS NULL OR c.last_subscription_order_at IS NULL
       THEN NULL
       ELSE EXTRACT(DAY FROM (c.last_subscription_order_at - c.first_subscription_order_at))::int
  END AS proxy_tenure_days,
  CASE WHEN c.last_subscription_order_at IS NULL THEN NULL
       ELSE EXTRACT(DAY FROM (now() - c.last_subscription_order_at))::int
  END AS days_since_last_subscription_order,

  c.is_subscriber,
  c.subscription_tier,
  c.subscription_status,
  c.derived_at,
  c.synced_at
FROM public.shopify_customers c;

COMMENT ON VIEW analytics.customers IS
  'One row per Shopify customer. email, first_name, last_name and raw_json are '
  'excluded — the base table is unreachable by this role. '
  'The derived columns (first_order_at through subscription_status) are a cache '
  'refreshed by the customer sync: NULL means the rollup has never run for that '
  'row, 0 means it ran and found nothing, and derived_at is the only way to tell '
  'them apart — check it before quoting any of them. '
  'lifetime revenue is split into subscription_revenue_cents and '
  'one_off_revenue_cents deliberately and has no combined column; add them only '
  'when the question really is about both. '
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
  'shopify_orders_count and shopify_total_spent_cents are Shopify''s own '
  'figures over all time; lifetime_orders and the revenue split are ours over '
  'the orders we hold, which begin 2025-07-22. Disagreement between them is the '
  'size of the history we are missing, not an error.';

DROP VIEW IF EXISTS analytics.segments CASCADE;
CREATE VIEW analytics.segments AS
SELECT s.id, s.name, s.definition, s.notes, s.member_count,
       s.last_evaluated_at, s.last_evaluation_error, s.created_at, s.updated_at
FROM public.segments s;

COMMENT ON VIEW analytics.segments IS
  'Named audience definitions. A segment IS its definition; member_count is a '
  'cache of what that definition returned at last_evaluated_at, never truth. '
  'A non-null last_evaluation_error means the count beside it is stale — the '
  'evaluator deliberately does not advance last_evaluated_at on a failed run. '
  'Definitions are predicates against analytics.customers aliased c.';

GRANT SELECT ON analytics.customers TO claude_readonly;
GRANT SELECT ON analytics.segments TO claude_readonly;
