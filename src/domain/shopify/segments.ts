/**
 * Named audience definitions and the evaluator that sizes them.
 *
 * A segment IS its predicate. `member_count` and `last_evaluated_at` are a
 * cache of what that predicate returned last time it ran; a count read without
 * its timestamp is a number with no date on it.
 *
 * ## Two different columns are called "tags", and only one is usable
 *
 * `shopify_orders.tags` looks like customer intent and is not. The tags are the
 * *product's* tags copied onto the order, so `homeschool` appears on 42,094 of
 * 54,225 orders — every order containing Color Happy, which is tagged
 * homeschool. A `homeschoolers` segment defined as "orders tagged homeschool"
 * returns roughly the whole customer base and looks entirely plausible while
 * doing it. Every behavioural segment below is therefore defined from what was
 * bought, by product title or type, never from an order tag.
 *
 * `shopify_customers.customer_tags` is the opposite and must not be tarred with
 * the same brush — that mistake was made here once already. Those tags are
 * written by the subscription apps and carry lifecycle state, and they are the
 * only complete record of who has lapsed. Seal cannot answer it: the business
 * has run three subscription apps and migrated twice, Shopify subscription apps
 * do not migrate cancelled subscribers, and so each migration dropped its
 * churned population. Seal holds 593 cancelled subscriptions; the tags hold
 * 15,364. Anything about churn is defined from customer_tags.
 *
 * ## Predicate safety
 *
 * These are SQL fragments interpolated into a counting query, and the table is
 * writable by Claude, so the fragment is untrusted input by design.
 * `assertSafePredicate` fails closed on anything that could end the statement
 * or write, and the count runs inside a read-only transaction. Read-only
 * subqueries are allowed — several definitions genuinely need them.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { segments, type NewSegment } from "@/db/schema";

/** The view segment predicates are evaluated against, aliased `c`. */
export const SEGMENT_SOURCE_VIEW = "analytics.customers";

/**
 * Bought a product made for a classroom. The Education Planner line is the
 * clearest teacher signal in the catalogue — it is a distinct SKU family, not
 * a tag anyone applied by hand.
 */
const TEACHER_TITLES = "Education Planner|Classroom|Teacher";

/** Homeschool-specific printables. A small, deliberately literal set. */
const HOMESCHOOL_TITLES = "Homeschool";

/** Gifting and redemption SKUs — someone buying for another person. */
const GIFT_TITLES = "^Gift |Gift Card|Redeem ";

/**
 * Both spellings are live in Shopify — `inactive_subscriber` on 9,065 customers
 * and `inactive-subscriber` on 7,847, written by different apps at different
 * times. Matching one drops roughly half the segment and still returns a
 * five-figure number that looks right.
 */
const LAPSED_TAGS = ["inactive_subscriber", "inactive-subscriber"];

/** Written by the current app while a subscription is live. */
const ACTIVE_TAG = "active-subscriber";

function hasAnyTag(tags: string[]): string {
  return `(${tags.map((t) => `c.customer_tags @> '["${t}"]'::jsonb`).join(" OR ")})`;
}

/**
 * Held a subscription under any app and holds none now.
 *
 * `@>` containment rather than the `?|` any-key operator: `?` is a parameter
 * placeholder in several drivers as well as an operator here, and a predicate
 * whose meaning depends on which one wins is not worth the brevity.
 */
const LAPSED_PREDICATE = `${hasAnyTag(LAPSED_TAGS)} AND NOT ${hasAnyTag([ACTIVE_TAG])}`;

/**
 * A recency band over the proxy cancellation date.
 *
 * `last_subscription_order_at IS NOT NULL` is load-bearing, not defensive.
 * 13,174 of the 15,364 lapsed have no subscription order in our history at all
 * — it begins 2025-07-22 and they churned before it — so without this clause
 * they would fall into whichever band NULL comparisons happen to land in and a
 * band would silently describe 14% of the people it claims to.
 */
function lapsedBand(minDays: number, maxDays: number | null): string {
  const since = "(now() - c.last_subscription_order_at)";
  const upper = maxDays === null ? "" : ` AND ${since} < interval '${maxDays} days'`;
  return (
    `${LAPSED_PREDICATE} AND c.last_subscription_order_at IS NOT NULL ` +
    `AND ${since} >= interval '${minDays} days'${upper}`
  );
}

function boughtTitleMatching(pattern: string): string {
  return (
    `EXISTS (SELECT 1 FROM analytics.shopify_orders o ` +
    `JOIN analytics.shopify_line_items li ON li.order_id = o.id ` +
    `WHERE o.customer_id = c.customer_id AND li.title ~* '${pattern}')`
  );
}

export const SEED_SEGMENTS: NewSegment[] = [
  {
    id: "teachers",
    name: "Teachers",
    definition: boughtTitleMatching(TEACHER_TITLES),
    notes:
      "Bought an Education Planner or another classroom SKU. Deliberately not " +
      "the 'educational-tools' tag: that tag is on 49,918 orders because it is " +
      "a product tag on Color Happy, not a statement about the buyer.",
  },
  {
    id: "homeschoolers",
    name: "Homeschoolers",
    definition: boughtTitleMatching(HOMESCHOOL_TITLES),
    notes:
      "Bought a homeschool-specific printable. Narrow on purpose. The " +
      "'homeschool' order tag would return ~42,000 of 54,225 orders because " +
      "Color Happy carries it, which is the failure mode this definition exists " +
      "to avoid. Under-counts anyone who homeschools but bought nothing " +
      "explicitly labelled for it — read this as a floor, not a population.",
  },
  {
    id: "adult_self_use",
    name: "Adults buying for themselves",
    definition:
      // Containment rather than the `?|` any-key operator: `?` is a parameter
      // placeholder in several drivers and an operator here, and a predicate
      // that depends on which one wins is not worth the brevity.
      `(${["Planners", "Stationery", "Font", "Markers", "Journals"]
        .map((t) => `c.product_types_purchased @> '["${t}"]'::jsonb`)
        .join(" OR ")}) ` +
      `AND NOT ${boughtTitleMatching(`${TEACHER_TITLES}|${HOMESCHOOL_TITLES}|Kids|Child`)} ` +
      `AND NOT ${boughtTitleMatching(GIFT_TITLES)}`,
    notes:
      "Bought adult-oriented stock and nothing classroom-, child- or gift-shaped. " +
      "The weakest definition here — it is an absence, and absence of a signal " +
      "is not presence of an adult. This is the segment under test against the " +
      "review-mining claim of ~19%; treat a match to that number as suggestive " +
      "and a mismatch as informative, because review-mining samples reviewers, " +
      "not buyers.",
  },
  {
    id: "gift_buyers",
    name: "Gift buyers",
    definition: boughtTitleMatching(GIFT_TITLES),
    notes:
      "Bought a gift or redemption SKU. Counts the purchaser, never the " +
      "recipient — the recipient is a different person and usually a different " +
      "customer record, so this segment must not be messaged as though they own " +
      "what was bought.",
  },
  {
    id: "planner_buyers",
    name: "Planner buyers",
    definition: `c.product_types_purchased @> '["Planners"]'::jsonb`,
    notes:
      "Any purchase of product_type 'Planners'. Overlaps teachers heavily by " +
      "design — the Education Planner is a planner.",
  },
  {
    id: "rad_subscribers_active",
    name: "RAD subscribers — active",
    definition: "c.is_subscriber = 1",
    notes:
      "Has at least one ACTIVE Seal subscription. Seal carries only Really " +
      "Awesome Doodles; Color Happy subscriptions were run in Appstle and are " +
      "not in this system at all, so this is a RAD number and not a " +
      "subscriber number. Shopify's own active-subscriber tag sits on 4,419 " +
      "customers against Seal's ~3,794 — kept on Seal because this segment is " +
      "read alongside tier and status, which only Seal has. Use the tag when " +
      "the question is how many people are subscribed, not what they are on.",
  },
  {
    id: "rad_subscribers_lapsed",
    name: "Lapsed subscribers (all apps)",
    definition: LAPSED_PREDICATE,
    notes:
      "Tagged inactive_subscriber or inactive-subscriber and not " +
      "active-subscriber. ~15,364 customers. Defined from customer_tags and " +
      "NOT from Seal: three subscription apps, two migrations, and Shopify " +
      "subscription apps do not migrate cancelled subscribers, so each " +
      "migration dropped its churned population and Seal holds only the " +
      "survivors of the last one. The Seal-based definition returned 71. " +
      "Both spellings are matched because both are in use. This spans Color " +
      "Happy and RAD together — the tags do not distinguish brand, and " +
      "color_happy_imported / appstle / seal-subscriber are the closest proxy.",
  },
  {
    id: "lapsed_under_12m",
    name: "Lapsed — under 12 months",
    definition: lapsedBand(0, 365),
    notes:
      "~1,794 customers. Banded on last_subscription_order_at, a proxy for " +
      "cancellation taken from the last order of a Subscription product. Only " +
      "the 2,190 lapsed customers who have such an order can be banded at all; " +
      "the rest are in lapsed_no_proxy_date and are not silently included here.",
  },
  {
    id: "lapsed_12_to_24m",
    name: "Lapsed — 12 to 24 months",
    definition: lapsedBand(365, 730),
    notes:
      "~396 customers, and they are an artefact worth knowing about: 370 of " +
      "them have their FIRST subscription order within 14 days of 2025-07-22, " +
      "where our order history starts. They were already subscribing when the " +
      "window opened, so their proxy tenure is truncated at the left edge and " +
      "every one of them reads as short-tenure regardless of what they were. " +
      "Treat tenure here as unknown, not short.",
  },
  {
    id: "lapsed_24m_plus",
    name: "Lapsed — 24 months or more",
    definition: lapsedBand(730, null),
    notes:
      "Structurally EMPTY, and expected to stay empty. Order history begins " +
      "2025-07-22, so the largest computable time-since is 413 days. A zero " +
      "here means the question cannot be asked from this data, not that nobody " +
      "churned that long ago — most of the 15,364 did. It exists as a " +
      "definition so that the zero is visible and explained rather than absent.",
  },
  {
    id: "lapsed_no_proxy_date",
    name: "Lapsed — no proxy date",
    definition: `${LAPSED_PREDICATE} AND c.last_subscription_order_at IS NULL`,
    notes:
      "~13,174 customers: 85.7% of the lapsed population, of whom 12,783 have " +
      "no order of any kind in our history. They churned before 2025-07-22, so " +
      "no signup date, cancellation date or tenure exists for them anywhere in " +
      "this system. They are reachable — we hold their email and their tags — " +
      "but they can only be split on tag, never on date. Splitting the lapsed " +
      "by tenure means addressing the other 14%, and this segment is what makes " +
      "that visible instead of leaving it as a shortfall nobody notices. " +
      "Recovering their dates needs an Appstle export, not more query work.",
  },
  {
    id: "lapsed_failed_payment",
    name: "Lapsed — involuntary (failed payment)",
    definition:
      `${LAPSED_PREDICATE} AND ` +
      hasAnyTag([
        "appstle-failed-payment",
        "failed-payment-color-happy",
        "ch-cancelled-failed-payment",
        "sub-failed-payment",
        "subscription-failed-payment",
      ]),
    notes:
      "Lapsed carrying any failed-payment tag — churn by card, not by choice. " +
      "A distinction worth keeping separate from voluntary churn because the " +
      "message that wins them back is a different message. Tag names differ by " +
      "app, hence the list; the union across all five is ~2,400 customers " +
      "before intersecting with lapsed.",
  },
  {
    id: "grandfathered_spark",
    name: "Grandfathered Spark",
    definition:
      "EXISTS (SELECT 1 FROM analytics.subscriptions s WHERE s.customer_id = " +
      "c.customer_id AND s.status = 'ACTIVE' AND s.tier = 'spark' AND " +
      "s.pricing_cohort = 'grandfathered')",
    notes:
      "Active Spark on legacy pricing. Tier and cohort come from variant_id, " +
      "never from price — a subscription can sit on a grandfathered variant at " +
      "a repriced amount.",
  },
  {
    id: "studio_upgraders",
    name: "Studio upgraders",
    definition:
      "EXISTS (SELECT 1 FROM analytics.subscriptions s " +
      "JOIN analytics.tier_change_events e ON e.subscription_id = s.id " +
      "WHERE s.customer_id = c.customer_id AND e.from_tier = 'spark' AND " +
      "e.to_tier = 'studio')",
    notes:
      "Moved Spark to Studio, read from Seal's log. That log begins 2026-05-22, " +
      "so an upgrade before then leaves no event and this segment cannot see it. " +
      "Zero coverage before that date means 'not recorded', not 'did not happen'.",
  },
  {
    id: "high_value",
    name: "High value (top decile)",
    definition:
      "(COALESCE(c.subscription_revenue_cents, 0) + COALESCE(c.one_off_revenue_cents, 0)) >= " +
      "(SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY " +
      "COALESCE(subscription_revenue_cents, 0) + COALESCE(one_off_revenue_cents, 0)) " +
      "FROM analytics.customers)",
    notes:
      "Top decile by combined lifetime revenue. The threshold is recomputed on " +
      "every evaluation, so membership moves as the base moves — this is a rank, " +
      "not a spend level, and two evaluations are not comparable as counts.",
  },
];

/**
 * Insert the seed definitions, leaving any that already exist alone.
 *
 * A definition someone has edited is the one they meant. Overwriting on every
 * deploy would revert an argued-over predicate to the shipped guess without
 * anyone seeing it happen, which defeats the point of storing the definition.
 */
export async function seedSegments(db: Db): Promise<number> {
  await db.insert(segments).values(SEED_SEGMENTS).onConflictDoNothing();
  return SEED_SEGMENTS.length;
}

/**
 * Fail-closed check on a stored predicate before it is interpolated.
 *
 * Read-only subqueries are permitted because several definitions need them.
 * Everything that could terminate the wrapping statement, comment out its
 * remainder, write, or block is rejected by name so the recorded error says
 * what was wrong.
 */
export function assertSafePredicate(definition: string): void {
  const trimmed = definition.trim();

  if (trimmed === "") {
    throw new Error("Unsafe segment predicate: empty. An empty predicate is not 'match everything'.");
  }
  if (trimmed.includes(";")) {
    throw new Error('Unsafe segment predicate: contains ";", which can end the statement.');
  }
  if (/--|\/\*|\*\//.test(trimmed)) {
    throw new Error("Unsafe segment predicate: contains a comment marker (-- or /* */).");
  }

  const banned = [
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "grant",
    "revoke",
    "create",
    "copy",
    "union",
    "into",
    "pg_sleep",
    "pg_read_file",
    "pg_ls_dir",
    "dblink",
    "lo_import",
    "lo_export",
    "set_config",
  ];
  for (const word of banned) {
    if (new RegExp(`\\b${word}\\b`, "i").test(trimmed)) {
      throw new Error(`Unsafe segment predicate: contains "${word}".`);
    }
  }
}

export interface SegmentEvaluationResult {
  evaluated: number;
  failed: number;
  /** Only successfully evaluated segments appear. A missing key is not zero. */
  sizes: Record<string, number>;
}

/**
 * Recount every segment.
 *
 * A failure records the error and leaves `member_count` and `last_evaluated_at`
 * untouched. Advancing the timestamp on a failed run would dress a stale count
 * as a current one, which is worse than having no count.
 */
export async function evaluateSegments(
  db: Db,
  now: Date
): Promise<SegmentEvaluationResult> {
  const rows = await db
    .select({ id: segments.id, definition: segments.definition })
    .from(segments);

  const sizes: Record<string, number> = {};
  let evaluated = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      assertSafePredicate(row.definition);

      const result = (await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM ${sql.raw(SEGMENT_SOURCE_VIEW)} c WHERE ${sql.raw(row.definition)}`
      )) as unknown as Array<{ count: number }>;

      const count = Number(result[0].count);

      await db
        .update(segments)
        .set({
          memberCount: count,
          lastEvaluatedAt: now,
          lastEvaluationError: null,
          updatedAt: now,
        })
        .where(sql`${segments.id} = ${row.id}`);

      sizes[row.id] = count;
      evaluated++;
    } catch (err) {
      await db
        .update(segments)
        .set({
          lastEvaluationError: err instanceof Error ? err.message : String(err),
          updatedAt: now,
        })
        .where(sql`${segments.id} = ${row.id}`);
      failed++;
    }
  }

  return { evaluated, failed, sizes };
}
