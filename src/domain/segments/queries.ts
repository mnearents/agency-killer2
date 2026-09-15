/**
 * Materialising a segment's members, and the push history the diff needs.
 *
 * ## Where the email comes from
 *
 * Segment predicates are written against `analytics.customers`, which has no
 * email column — PII is excluded from that view deliberately, and the counts
 * in `evaluateSegments` never need it. A push does: Attentive matches people
 * by identifier. So the predicate still evaluates against the same view (same
 * semantics as the counts, no second definition to drift) and the address is
 * joined back from the base table.
 *
 * **The join key is `customer_gid`, not `customer_id`.** `shopify_customers.id`
 * is a Shopify GID — `gid://shopify/Customer/5026484650136` — while the view's
 * `customer_id` is the bare numeric id. Joining on the latter matches nothing,
 * and the first version of this function did, so a segment of 15,383 people
 * reported "matched nobody, nothing to push". That is indistinguishable from a
 * correct empty result, which is why the predicate is counted separately below:
 * a predicate that matched people while the join produced none is a fault, not
 * an empty segment, and the two need opposite responses.
 *
 * ## Consent
 *
 * `accepts_marketing` is applied here rather than left to Attentive. Shopify
 * consent and Attentive marketing eligibility are different things that
 * disagree by about 13% on this cohort — Attentive's eligibility decides
 * whether a message lands, but our own opt-out decides whether someone belongs
 * in the file at all, and that is not a decision to delegate.
 *
 * ## Reads, with one append
 *
 * No update and no delete. A corrected push is a new push.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { segmentPushes, segmentPushMembers } from "@/db/schema";
import { SEGMENT_SOURCE_VIEW, assertSafePredicate } from "@/domain/shopify/segments";

export interface MembershipResult {
  /** Normalised, deduplicated addresses. Meaningless when `error` is set. */
  emails: string[];
  /**
   * How many rows the predicate matched, counted without the join. Compared
   * against `emails` to tell a broken join from an empty segment.
   */
  matched: number;
  /** Non-null when the read failed. `emails` is then meaningless, not empty. */
  error: string | null;
}

/**
 * The addresses a segment currently covers.
 *
 * Runs in a read-only transaction for the same reason `evaluateSegments` does:
 * the predicate is raw SQL out of a column Claude can write, and a keyword
 * blocklist over raw SQL is one unlisted spelling away from being wrong.
 * `accessMode` is the layer under `assertSafePredicate`, not a substitute.
 */
export async function getSegmentMembers(
  db: Db,
  definition: string,
  opts: { requireMarketingConsent?: boolean } = {}
): Promise<MembershipResult> {
  const requireConsent = opts.requireMarketingConsent ?? true;

  try {
    assertSafePredicate(definition);
  } catch (err) {
    return { emails: [], matched: 0, error: `unsafe predicate: ${String(err)}` };
  }

  try {
    const consentClause = requireConsent ? sql` AND c.accepts_marketing = 1` : sql``;

    const { matched, rows } = await db.transaction(
      async (tx) => {
        // Counted on its own, so the join can be checked against it.
        const counted = (await tx.execute(
          sql`SELECT COUNT(*)::int AS count
              FROM ${sql.raw(SEGMENT_SOURCE_VIEW)} c
              WHERE ${sql.raw(definition)}`
        )) as unknown as Array<{ count: number }>;

        const joined = (await tx.execute(
          sql`SELECT sc.email AS email
              FROM ${sql.raw(SEGMENT_SOURCE_VIEW)} c
              JOIN shopify_customers sc ON sc.id = c.customer_gid
              WHERE ${sql.raw(definition)}${consentClause}
                AND sc.email IS NOT NULL AND sc.email <> ''`
        )) as unknown as Array<{ email: string }>;

        return { matched: Number(counted[0]?.count ?? 0), rows: joined };
      },
      { accessMode: "read only" }
    );

    const emails = [...new Set(rows.map((r) => r.email.trim().toLowerCase()))].sort();

    // Zero is UNKNOWN until something proves it means zero. A predicate that
    // matched people and a join that produced none is a broken join, and
    // reporting it as an empty segment sends someone to look at the data
    // instead of the query.
    if (matched > 0 && emails.length === 0) {
      return {
        emails: [],
        matched,
        error:
          `The predicate matched ${matched} customers but the join to shopify_customers ` +
          `produced none, so no address could be resolved. This is a join or consent-filter ` +
          `fault, not an empty segment — refusing rather than reporting nobody matched.`,
      };
    }

    return { emails, matched, error: null };
  } catch (err) {
    // Returned, not thrown, and never alongside a plausible-looking empty
    // list: a failed read and a segment that matched nobody are different
    // facts that need opposite responses.
    return { emails: [], matched: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface LastPush {
  id: string;
  planToken: string;
  members: string[];
  createdAt: Date;
}

/**
 * The membership of the most recent COMPLETED real push, or `null` when this
 * segment has never been pushed.
 *
 * `null` is load-bearing: it means Attentive holds nothing for this segment,
 * which is a different thing from a previous push that sent an empty list —
 * and the plan reports the first as `isFirstPush`.
 *
 * Dry runs are excluded. A dry run changed nothing in Attentive, so treating
 * one as the baseline would make the next real push compute its adds against
 * a state that never existed.
 */
export async function getLastRealPush(db: Db, segmentId: string): Promise<LastPush | null> {
  const [push] = await db
    .select()
    .from(segmentPushes)
    .where(and(eq(segmentPushes.segmentId, segmentId), eq(segmentPushes.dryRun, 0)))
    .orderBy(desc(segmentPushes.createdAt))
    .limit(1);

  if (!push) return null;

  const members = await db
    .select({ email: segmentPushMembers.email })
    .from(segmentPushMembers)
    .where(eq(segmentPushMembers.pushId, push.id));

  return {
    id: push.id,
    planToken: push.planToken,
    members: members.map((m) => m.email),
    createdAt: push.createdAt,
  };
}

export interface RecordPushInput {
  id: string;
  segmentId: string;
  externalId: string;
  dryRun: boolean;
  planToken: string;
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  reachableChecked: number | null;
  reachableEligible: number | null;
  batchJobIds: string[];
  recordsSucceeded: number | null;
  recordsFailed: number | null;
  problem: string | null;
  pushedBy: string;
  createdAt: Date;
  /** The full membership sent. Only stored for a real push. */
  members: string[];
}

/** Insert only. A corrected push is a new push, never an edit to an old one. */
export async function recordPush(db: Db, input: RecordPushInput): Promise<void> {
  await db.insert(segmentPushes).values({
    id: input.id,
    segmentId: input.segmentId,
    externalId: input.externalId,
    dryRun: input.dryRun ? 1 : 0,
    planToken: input.planToken,
    addedCount: input.addedCount,
    removedCount: input.removedCount,
    unchangedCount: input.unchangedCount,
    reachableChecked: input.reachableChecked,
    reachableEligible: input.reachableEligible,
    batchJobIds: input.batchJobIds,
    recordsSucceeded: input.recordsSucceeded,
    recordsFailed: input.recordsFailed,
    problem: input.problem,
    pushedBy: input.pushedBy,
    createdAt: input.createdAt,
  });

  // Only a real push defines what Attentive holds, so only a real push stores
  // membership. A dry run that stored members would become the baseline for
  // the next diff and silently describe a state that never existed.
  if (!input.dryRun && input.members.length > 0) {
    const rows = input.members.map((email) => ({ pushId: input.id, email }));
    for (let i = 0; i < rows.length; i += 5_000) {
      await db.insert(segmentPushMembers).values(rows.slice(i, i + 5_000));
    }
  }
}

export async function getPushHistory(db: Db, segmentId?: string, limit = 20) {
  const base = db.select().from(segmentPushes);
  const q = segmentId ? base.where(eq(segmentPushes.segmentId, segmentId)) : base;
  return q.orderBy(desc(segmentPushes.createdAt)).limit(limit);
}
