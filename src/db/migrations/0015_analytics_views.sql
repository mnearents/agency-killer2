-- Read-only analytics surface for the `query` MCP tool.
--
-- The security model is the schema, not a filter. `claude_readonly` is granted
-- SELECT on these views and on nothing else, so a column absent here is
-- unreachable rather than merely un-asked-for. Adding a column to a base table
-- does not expose it; someone has to widen a view on purpose.
--
-- Excluded everywhere:
--   seal_subscriptions.email          the one real customer identifier we store
--   *.raw_json                        unbounded API payloads; may carry names,
--                                     addresses, card metadata, anything
--   agent_sessions.cookies_json       session credentials — table not exposed
--
-- Included deliberately:
--   customer_id      opaque on its own, and the only way to join the two halves
--                    of the business together
--   seal_subscriptions.log            audited: all 3,778 entries across 35
--                    templates name WHICH field changed ("Merchant changed
--                    first name in shipping address") and never the value. The
--                    only quoted strings are product titles.

CREATE SCHEMA IF NOT EXISTS analytics;

-- ---------------------------------------------------------------- subscriptions
DROP VIEW IF EXISTS analytics.subscriptions CASCADE;
CREATE VIEW analytics.subscriptions AS
SELECT
  s.id,
  s.order_id,
  s.shopify_order_id,
  s.manual_origin,
  -- Already bare numeric. Joins straight to analytics.shopify_orders.customer_id.
  s.customer_id,
  s.status,
  s.tier,
  s.pricing_cohort,
  s.variant_id,
  s.product_id,
  s.variant_sku,
  s.product_title,
  s.selling_plan_id,
  s.selling_plan_name,
  s.plan_conflict,
  s.price_cents,
  s.price_anomaly,
  s.currency,
  s.billing_interval,
  s.billing_cadence,
  s.cadence_note,
  s.order_placed,
  s.next_billing_date,
  s.cancelled_on,
  s.cancellation_reason,
  s.in_dunning,
  s.last_error_code,
  s.last_error_at,
  s.log,
  s.tags,
  s.detail_checked_at,
  s.synced_at
FROM public.seal_subscriptions s;

COMMENT ON VIEW analytics.subscriptions IS
  'Current state, one row per Seal subscription. email and raw_json excluded. '
  'price_cents is the amount billed per billing_interval, NOT per month — '
  'divide a 12 month interval by 12 before comparing to a monthly one. '
  'Rows with price_anomaly = 1 are data faults and are excluded from every '
  'money number the purpose-built tools report; exclude them here too.';

-- ------------------------------------------------------- subscription snapshots
DROP VIEW IF EXISTS analytics.subscription_snapshots CASCADE;
CREATE VIEW analytics.subscription_snapshots AS
SELECT
  n.id,
  n.snapshot_date,
  n.subscription_id,
  n.status,
  n.tier,
  n.pricing_cohort,
  n.billing_interval,
  n.billing_cadence,
  n.cadence_note,
  n.price_cents,
  n.in_dunning,
  n.created_at
FROM public.seal_subscription_snapshots n;

COMMENT ON VIEW analytics.subscription_snapshots IS
  'Daily photograph of every subscription, beginning 2026-09-02. A change made '
  'after a day''s snapshot was written is invisible to it, so snapshots '
  'undercount movement. Use tier_change_events for movement; these corroborate.';

-- ---------------------------------------------------------- tier change events
DROP VIEW IF EXISTS analytics.tier_change_events CASCADE;
CREATE VIEW analytics.tier_change_events AS
SELECT
  e.subscription_id,
  e.changed_at,
  e.from_tier,
  e.to_tier,
  e.direction,
  e.pricing_cohort,
  e.price_change_logged,
  s.price_cents AS price_cents_now,
  s.status      AS subscription_status_now,
  s.billing_interval
FROM public.seal_tier_change_events e
LEFT JOIN public.seal_subscriptions s ON s.id = e.subscription_id;

COMMENT ON VIEW analytics.tier_change_events IS
  'One row per tier move, parsed from Seal''s log, which begins 2026-05-22. '
  'A window ending before that date has no coverage — zero rows there means '
  '"not recorded", not "nothing happened". '
  'There is no price_before/price_after: Seal writes no price entry when the '
  'price follows the variant, so 0 of the events on record carry one and '
  'price_change_logged is false on all of them. price_cents_now is the '
  'subscription''s price TODAY, not at the time of the change. To find changes '
  'that were never repriced, compare price_cents_now against the tier grid. '
  'A subscription may appear several times; count DISTINCT subscription_id for '
  'subscribers moved, and fold to first/last to get net direction.';

-- --------------------------------------------------------------- shopify orders
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
  o.referring_site,
  o.utm_source,
  o.utm_medium,
  o.utm_campaign,
  o.utm_content,
  o.utm_term,
  o.is_recurring,
  o.tags,
  o.discount_codes,
  o.order_created_at,
  o.synced_at
FROM public.shopify_orders o;

COMMENT ON VIEW analytics.shopify_orders IS
  'One row per Shopify order. raw_json excluded — it carries the full customer '
  'and shipping payload. customer_id is the bare numeric id, already extracted '
  'from the GID, and joins directly to analytics.subscriptions.customer_id.';

DROP VIEW IF EXISTS analytics.shopify_line_items CASCADE;
CREATE VIEW analytics.shopify_line_items AS
SELECT l.id, l.order_id, l.product_id, l.variant_id, l.product_type,
       l.sku, l.title, l.quantity, l.price_cents
FROM public.shopify_line_items l;

DROP VIEW IF EXISTS analytics.shopify_inventory CASCADE;
CREATE VIEW analytics.shopify_inventory AS
SELECT i.id, i.product_id, i.product_title, i.variant_title, i.sku,
       i.quantity, i.tracked, i.product_status, i.product_type,
       i.price_cents, i.synced_at
FROM public.shopify_inventory i;

-- ------------------------------------------------------------------------ meta
DROP VIEW IF EXISTS analytics.meta_insights CASCADE;
CREATE VIEW analytics.meta_insights AS
SELECT m.id, m.ad_id, m.campaign_id, m.adset_id, m.date,
       m.impressions, m.clicks, m.spend_cents, m.reach, m.cpm, m.cpc, m.ctr,
       m.frequency, m.cpp, m.purchases, m.purchase_value_cents,
       m.add_to_cart, m.initiate_checkout,
       m.publisher_platform, m.platform_position, m.attribution_window,
       m.synced_at
FROM public.meta_insights m;

COMMENT ON VIEW analytics.meta_insights IS
  'Daily ad performance. Rows exist per breakdown (publisher_platform, '
  'platform_position), so summing without filtering or grouping double counts '
  'spend. Money is cents.';

DROP VIEW IF EXISTS analytics.meta_campaigns CASCADE;
CREATE VIEW analytics.meta_campaigns AS
SELECT c.id, c.account_id, c.name, c.status, c.objective, c.buying_type,
       c.daily_budget_cents, c.lifetime_budget_cents,
       c.start_time, c.stop_time, c.synced_at
FROM public.meta_campaigns c;

DROP VIEW IF EXISTS analytics.meta_adsets CASCADE;
CREATE VIEW analytics.meta_adsets AS
SELECT a.id, a.campaign_id, a.name, a.status, a.targeting,
       a.optimization_goal, a.billing_event, a.bid_strategy,
       a.daily_budget_cents, a.lifetime_budget_cents,
       a.start_time, a.stop_time, a.synced_at
FROM public.meta_adsets a;

DROP VIEW IF EXISTS analytics.meta_ads CASCADE;
CREATE VIEW analytics.meta_ads AS
SELECT a.id, a.adset_id, a.campaign_id, a.name, a.status, a.creative_id, a.synced_at
FROM public.meta_ads a;

DROP VIEW IF EXISTS analytics.meta_creatives CASCADE;
CREATE VIEW analytics.meta_creatives AS
SELECT c.id, c.name, c.title, c.body, c.image_url, c.video_url,
       c.call_to_action_type, c.object_type, c.synced_at
FROM public.meta_creatives c;

-- -------------------------------------------------------------------- attentive
DROP VIEW IF EXISTS analytics.attentive_campaigns CASCADE;
CREATE VIEW analytics.attentive_campaigns AS
SELECT a.id, a.date, a.message_variant, a.has_media, a.delivered,
       a.total_clicks, a.total_click_rate, a.conversions, a.conversion_rate,
       a.revenue_cents, a.unsubscribes, a.unsubscribe_rate, a.imported_at
FROM public.attentive_campaigns a;

COMMENT ON VIEW analytics.attentive_campaigns IS
  'Email/SMS campaign performance. Attentive has no API — these are imported '
  'by hand, so coverage is whatever was last pasted in. Check imported_at '
  'before reading a recent window as complete.';

DROP VIEW IF EXISTS analytics.attentive_revenue CASCADE;
CREATE VIEW analytics.attentive_revenue AS
SELECT a.id, a.date, a.conversions, a.revenue_cents,
       a.avg_order_value_cents, a.imported_at
FROM public.attentive_revenue a;

-- ----------------------------------------------------------------------- other
DROP VIEW IF EXISTS analytics.social_posts CASCADE;
CREATE VIEW analytics.social_posts AS
SELECT p.id, p.ig_user_id, p.caption, p.media_type, p.media_product_type,
       p.permalink, p.like_count, p.comments_count, p.impressions, p.reach,
       p.saved, p.shares, p.plays, p.total_interactions, p.posted_at, p.synced_at
FROM public.social_posts p;

DROP VIEW IF EXISTS analytics.sync_runs CASCADE;
CREATE VIEW analytics.sync_runs AS
SELECT r.id, r.task, r.outcome, r.window_start, r.window_end, r.rows_written,
       r.error_code, r.started_at, r.finished_at
FROM public.sync_runs r;

COMMENT ON VIEW analytics.sync_runs IS
  'One row per scheduled sync. The honest answer to "is this data current?" — '
  'check the latest successful run for a task before trusting its table. '
  'error_message is excluded; error_code is the stable field.';

DROP VIEW IF EXISTS analytics.pilot_notes CASCADE;
CREATE VIEW analytics.pilot_notes AS
SELECT n.id, n.note_id, n.kind, n.title, n.body, n.category, n.author, n.created_at
FROM public.pilot_notes n;

DROP VIEW IF EXISTS analytics.blog_topics CASCADE;
CREATE VIEW analytics.blog_topics AS
SELECT b.id, b.title, b.description, b.target_date, b.priority, b.status,
       b.tags, b.repeat_yearly, b.created_at, b.updated_at
FROM public.blog_topics b;

DROP VIEW IF EXISTS analytics.calendar_entries CASCADE;
CREATE VIEW analytics.calendar_entries AS
SELECT c.id, c.date, c.channel, c.title, c.status, c.notes, c.ai_suggested,
       c.created_at, c.updated_at
FROM public.calendar_entries c;

DROP VIEW IF EXISTS analytics.query_log CASCADE;
CREATE VIEW analytics.query_log AS
SELECT q.id, q.ran_at, q.sql_text, q.row_count, q.truncated,
       q.duration_ms, q.error_message
FROM public.query_log q;

COMMENT ON VIEW analytics.query_log IS
  'Every statement the query tool has run, including the failures.';

-- ------------------------------------------------------------ the read-only role
--
-- Created here without LOGIN so the grants below always have something to
-- attach to and a redeploy cannot leave the views ungranted. The role cannot
-- connect until scripts/setup-analytics-role.ts gives it a password, so an
-- unprovisioned deploy fails closed rather than opening an unauthenticated
-- account.
--
-- Views are owned by postgres and are not SECURITY INVOKER, so they read the
-- base tables with the owner's rights. That is what lets this role select
-- through them while having no privilege on public.* at all — the exclusion is
-- structural, not a filter that could be forgotten.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    CREATE ROLE claude_readonly NOLOGIN;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM claude_readonly;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM claude_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM claude_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM claude_readonly;

GRANT USAGE ON SCHEMA analytics TO claude_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO claude_readonly;

-- Anything added to analytics later is readable; anything added to public is
-- not. The default for new objects follows the same asymmetry on purpose.
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO claude_readonly;

-- Belt and braces behind the tool-layer cap: a runaway statement dies in the
-- database even if it were somehow submitted outside the tool.
ALTER ROLE claude_readonly SET statement_timeout = '30s';
ALTER ROLE claude_readonly SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE claude_readonly SET default_transaction_read_only = on;
ALTER ROLE claude_readonly SET search_path = analytics;
