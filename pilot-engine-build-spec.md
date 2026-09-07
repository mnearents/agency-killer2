# Pilot Engine — Build Spec

> **Amendments since authoring** (added when this document was committed to the repo;
> delete this block if you want the original verbatim). The body below is unchanged —
> these are the known divergences between the spec as written and the state of the code.
>
> - **Prompt F item 1 (`pilot_notes`) is built and shipped.** The spec says "still
>   unbuilt." Items 2–4 of that prompt remain open.
> - **Prompt E's review count is stale.** The spec says "163 reviews today, all on the
>   rad-club handle." The real figure is **536 across the whole store**: 163 rad-club,
>   162 planners and calendars, 20 baby quilt, 18 Rad Mail, the rest spread across the
>   catalog. Two tagging targets are also missing from the spec — multi-year loyalty
>   language (11% of all reviews, the strongest proof point in the dataset) and
>   fulfillment/customer-service complaints (3 of the 6 one-star reviews).
> - **Two Prompt-adjacent bugs are already fixed** in `b2b40fd`: the Meta ads status tool
>   no longer filters on `status = 'ACTIVE'`, and the creative `image_url` now falls back
>   through `object_story_spec` to `thumbnail_url`.
> - The shared-inventory-pool problem described in Prompt B is tracked separately as its
>   own issue, since it is a live oversell exposure rather than a line-items dependency.
>
> Tracked as GitHub issues on `mnearents/agency-killer2`. This document is the spec of
> record; the issues are the working surface.

Goal: Claude operates as head of marketing directly against the data, rather than
specifying analyses for a developer to build. The bottleneck today is that every new
question requires a build cycle.

Ordered by leverage. Phase 1 alone changes the working model; everything after fills gaps.

---

# PHASE 1 — The unlock

## Prompt A — Read-only SQL access

```
Build a `query` MCP tool giving Claude read-only SQL against the warehouse. This is the
highest-leverage tool in the system: it removes the build cycle between a question and
an answer.

SECURITY MODEL — views, not tables.

1. Create a dedicated Postgres role `claude_readonly`. GRANT SELECT only. No INSERT,
   UPDATE, DELETE, DDL, or function execution.

2. Create a schema `analytics` containing read-only VIEWS over the real tables. The role
   gets access to the views ONLY, never base tables. PII is excluded at the view layer so
   it is structurally unreachable rather than filtered by a deny-list.

   EXCLUDE from every view: customer email, first/last name, phone, street address,
   card_brand, card_last_digits, payment_method_id, ip_address, and raw_json/log columns
   that may contain any of the above.

   INCLUDE: customer_id (opaque identifier — needed for joins, not identifying on its own),
   and any aggregate or behavioural field.

   Views needed at minimum, one per existing table: subscriptions, subscription_snapshots,
   shopify_orders, meta_insights, meta_creatives, meta_campaigns, social_posts,
   inventory, attentive_*, and anything else already synced.

3. Enforce at the tool layer:
   - statement_timeout = 30s on the role
   - hard cap of 5,000 returned rows; if a query would exceed it, return the first 5,000
     and say so explicitly rather than truncating silently
   - reject any statement that is not a single SELECT or WITH...SELECT
   - log every query with timestamp, SQL text, row count, and duration to a query_log table

4. The tool description must list available views and their columns, so Claude can write
   correct SQL without guessing schema. Include a `describe` action that returns the
   current view definitions — this must read from the live catalog, not a hardcoded list,
   so it can never drift.

Keep all existing purpose-built tools. They encode decisions (how MRR amortises annual
plans, how dunning is derived) that shouldn't be re-derived ad hoc. SQL is for the
questions nobody anticipated.
```

## Prompt B — Order line items

```
Add order line items to the Shopify sync. Their absence blocks product-level analysis
entirely: basket analysis, bundle discovery, attach rates, per-product revenue, and
correct inventory velocity all depend on them.

Table `shopify_order_line_items`: order_id (FK to shopify_orders), product_id, variant_id,
sku, title, variant_title, quantity, price_cents, total_discount_cents, requires_shipping,
product_type, vendor.

Backfill the full history from shopify_orders.raw_json if line items are present there —
check before assuming. If raw_json lacks them, backfill from the Shopify API.

Then fix `inventory_status`: unitsSoldLast30d currently returns 0 for every one of 41
items, which makes three of its five classifications (stockout, critical-cover, low-cover)
dead code. Compute velocity from line items.

Note: the Halloween bag quantity-break variants share one inventory pool (BAGHLLWN2023 has
796 real units reported as 1,927 across seven variants). The Mechanic app that kept them in
sync is uninstalled. Group variants sharing a pool and report real stock, and flag the
oversell exposure until a replacement app is in place.

Add a view for this table in the analytics schema per Prompt A.
```

## Prompt C — Customers and segments

```
Build a customers table. Audience segmentation has been a stated goal since day one and
there is currently no way to query a customer at all.

`shopify_customers`: customer_id, created_at, orders_count, total_spent_cents, tags,
accepts_marketing, state, city, country. NO email, name, phone, or street address in the
analytics view (see Prompt A).

Derive and store per customer:
  - first_order_at, last_order_at, days_since_last_order
  - is_subscriber (join to seal_subscriptions via split_part(customer_id,'/',5))
  - subscription_tier, subscription_status where applicable
  - lifetime_orders, lifetime_revenue_cents split into subscription vs one-off
  - product_types_purchased (array, from line items)

Then a `segments` table Claude can WRITE to: segment_name, definition (SQL predicate or
structured filter), created_at, notes, last_evaluated_at, member_count. This exists so
"teachers" means the same thing in every analysis rather than being redefined each time.

Segments to seed, based on product tags and purchase behaviour:
  teachers, homeschoolers, adult_self_use, gift_buyers, planner_buyers,
  rad_subscribers_active, rad_subscribers_lapsed, grandfathered_spark,
  studio_upgraders, high_value (top decile by lifetime revenue)

Report the size of each once built. I expect surprises — review-mining suggested
adults-buying-for-themselves is roughly 19% of customers while homeschool is ~2%,
which inverts how these segments have been prioritised.
```

---

# PHASE 2 — Close the blind spots

## Prompt D — Web analytics and Search Console

```
Two syncs. Both are currently invisible to the system, and a 62% year-over-year traffic
collapse was discovered only because a human exported a CSV by hand.

1. GA4 (or Shopify Analytics if GA4 isn't configured — check which exists):
   daily sessions, users, conversion rate, revenue, split by channel grouping
   (organic, paid, direct, email, social, referral). Plus landing page performance.
   Backfill as far as the API allows.

2. Google Search Console, daily sync into Postgres:
   queries, pages, clicks, impressions, CTR, position, device, country.
   GSC retains only 16 months and pre-Sept-2025 history is already permanently lost.
   Every day without this sync loses another day forever. Backfill everything available.

Add an `seo_status` tool surfacing branded vs non-branded split, position changes, and
pages gaining or losing.

Context for the branded/non-branded split: 93% of organic clicks are branded. "Color
Happy" still draws 2,553 clicks while "really awesome doodles" draws literally zero. The
undated-planner query cluster is climbing unaided (position 13.24 → 8.9) and is the one
real non-brand opportunity.
```

## Prompt E — Attentive detail and Judge.me

```
1. Attentive is currently aggregate-only — one number per channel for a date range. Expand to:
   - Per-campaign: name, send date, channel, audience/segment, delivered, clicks,
     conversions, revenue, unsubscribes
   - Per-journey and per-message within journey
   - Segment/list membership counts over time

   The 15,000 lapsed RAD subscribers are the largest single opportunity in the business
   and are currently invisible. If the Attentive API exposes segment membership, sync it.

2. Judge.me reviews: rating, title, body, date, product_handle, reviewer location,
   verified status. 163 reviews today, all on the rad-club handle.

   Add derived tagging by use case (classroom, homeschool, adult self-use, gifting,
   grandparent, travel, professional/clinical, screen-free) so segment sizing can be
   evidence-based rather than assumed.
```

---

# PHASE 3 — Write access, scoped

## Prompt F — Pilot notes, experiments, drafts, calendar

```
Claude needs to write its own work product. Business systems (Seal, Shopify, Meta,
Attentive) stay strictly read-only. These four tables are the exception.

1. `pilot_notes` — as previously specified and still unbuilt. Append-only.
   kind: decision | watch | todo | correction | baseline | session
   title, body, confidence (verified|inferred|assumed), invalidates_when,
   status (open|resolved|superseded), superseded_by, tags[], review_after
   Tools: pilot_notes_add (write), pilot_notes_get (defaults status=open),
   pilot_notes_export (markdown).

2. `experiments` — the accountability layer. Without this, recommendations become folklore
   and nobody can tell which ones worked.
   name, hypothesis, what_we_changed, start_date, end_date, success_criteria (defined
   BEFORE the result is known), primary_metric, baseline_value, result_value, outcome
   (win|loss|inconclusive|running), learnings, related_note_ids[]

   Tools: experiment_start, experiment_record_result, experiments_list.
   experiment_start MUST require success_criteria — a test without a pre-declared bar is
   how post-hoc rationalisation happens.

3. `drafts` — campaign briefs, ad copy, email/SMS drafts, product descriptions.
   type, title, channel, body, status (draft|approved|rejected|shipped), created_at,
   tara_feedback. Claude writes drafts. Claude never publishes. Approval happens outside
   the system and gets recorded here.

   Every draft must pass voice_check (see Prompt G) before being saved.

4. `calendar_entries` — currently read-only and empty, which is why the "no sends in 7
   days" alert fires unconditionally and trains everyone to ignore alerts. Add write.
   date, channel, type, title, description, status (planned|shipped|cancelled),
   linked_draft_id, linked_experiment_id.

Add all four to data_freshness.
```

## Prompt G — Fix brand voice

```
The voice tool is producing channel-inappropriate copy: Instagram conventions like
"comment below" leak into emails and blogs, because all 34 samples are Instagram and the
rules are one flat list.

1. Tag every sample with `channel` (instagram|email|sms|ad|product_page) and `intent`
   (launch|nurture|story|educational|promo). All samples currently have tags: [].

2. Split rules into three layers:
   - global (always apply): no em dashes, no vulgarity
   - channel-specific: "comment below" and comment-to-DM CTAs are Instagram-only, and
     must be EXCLUDED elsewhere rather than banned everywhere
   - banned words: hard blocklist

3. `brand_voice(channel)` returns only that channel's samples plus applicable rules.

4. NEW: `voice_check(text, channel)` returns violations. This is the highest-leverage
   part — rules that can't be enforced are wishes. Everything that generates copy runs
   its own output through this before saving.

5. Fix the IGMULTI ingestion bug: that single sample is ~40 unrelated captions
   concatenated into one blob (Lottie the puppy, Iceland, a Mixbook affiliate code). It
   is the largest sample and will dominate any few-shot prompt. Split or drop it.

6. Seed email and SMS samples — there are currently none. Use Tara's best-performing
   Attentive sends: the Dated Things newsletter and the July 2024 planner launch.

Note the current contradiction: rule 3 bans "comments get" while samples IG2, IG6 and
IG32 all say "All comments get a link." "delight" is banned while IG13 says "a delight to
look at." Few-shot examples override written rules in practice.
```

---

# Explicitly NOT building yet

- **Video pipeline** (`src/domain/video/`, shotstack, playwright). Ads are off, there is no
  new creative to edit, and no performance data to guide what to make. Revisit once ads run.
- **Wholesale tooling.** The bottleneck is a line sheet and terms, not software. The
  Railway prospect service already works; connect it via shared Postgres when the time comes.
- **Anything predictive or forecasting.** Not enough clean history.
- **New dashboards.** The weekly report subscription block is sufficient.

---

# Guardrails

**Read-only forever:** Seal, Shopify, Meta, Attentive, Judge.me. No mutations, no
publishing, no budget changes, no campaign edits.

**Write-enabled:** pilot_notes, experiments, drafts, calendar_entries, segments, query_log.
Claude's own work product only.

**PII:** excluded at the view layer, not filtered at the tool layer. Claude should be
structurally unable to read customer emails, names, addresses, or card metadata.

**Every recommendation gets an experiment record with success criteria declared before
the result is known.** This is the difference between a marketing partner and an agency
that produces confident-sounding work nobody can audit.
