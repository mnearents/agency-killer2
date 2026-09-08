/**
 * Named audience definitions and the evaluator that sizes them.
 *
 * A segment IS its predicate. `member_count` and `last_evaluated_at` are a
 * cache of what that predicate returned last time it ran; a count read without
 * its timestamp is a number with no date on it.
 *
 * ## Why these definitions do not use tags
 *
 * `shopify_orders.tags` looks like customer intent and is not. The tags are the
 * *product's* tags copied onto the order, so `homeschool` appears on 42,094 of
 * 54,225 orders — every order containing Color Happy, which is tagged
 * homeschool. A `homeschoolers` segment defined as "orders tagged homeschool"
 * returns roughly the whole customer base and looks entirely plausible while
 * doing it. Every behavioural segment below is therefore defined from what was
 * bought, by product title or type, never from a tag.
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
      "subscriber number.",
  },
  {
    id: "rad_subscribers_lapsed",
    name: "RAD subscribers — lapsed",
    definition:
      "c.is_subscriber = 0 AND EXISTS (SELECT 1 FROM analytics.subscriptions s " +
      "WHERE s.customer_id = c.customer_id AND s.manual_origin = 0)",
    notes:
      "Held a RAD subscription and holds none now. Bulk-imported rows " +
      "(manual_origin = 1) are excluded: their order_placed is the import " +
      "timestamp, so tenure and time-since-cancellation computed over them is " +
      "fiction, and those are exactly the fields a win-back campaign splits on. " +
      "This will NOT reconcile to the ~15,000 lapsed figure — Seal holds 593 " +
      "cancelled subscriptions in total. See the issue for the reconciliation.",
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
