/**
 * The push plan — what would change in Attentive, computed before anything is
 * sent, and the thing a human actually approves.
 *
 * ## Why the diff comes from our own history
 *
 * Attentive exposes no endpoint that reads segment membership back. That
 * absence is why #23 inverted into #32: we cannot ask what is in a segment, so
 * the only possible basis for a diff is a record of what we last pushed.
 *
 * It follows that removals are impossible without that history — and removals
 * matter, because a segment that is only ever added to is wrong the moment
 * someone resubscribes, and they keep receiving win-back campaigns as a paying
 * customer.
 *
 * ## Why the push re-derives this rather than accepting it
 *
 * If the push tool took a list of addresses, every guarantee here would be
 * advisory: the caller could pass a different list and nothing would notice.
 * So the push recomputes the plan and takes a `planToken` derived from the
 * diff the human was shown. A token that no longer matches means the data
 * moved underneath the approval, and the answer is a fresh dry-run.
 *
 * Pure functions only — no database, no network, no clock.
 */

import { createHash } from "node:crypto";

/** The API's own cap, mirrored here so batching is testable without the client. */
export const MAX_MEMBERS_PER_REQUEST = 10_000;

export interface Reachability {
  /** How many addresses were looked up. */
  checked: number;
  /** How many Attentive has at all. */
  known: number;
  /** How many a marketing message would actually reach, on any channel. */
  marketingEligible: number;
}

export interface PushPlanInput {
  segmentId: string;
  externalId: string;
  currentMembers: string[];
  /** `null` means this segment has never been pushed — not that it was empty. */
  lastPushedMembers: string[] | null;
  reachability?: Reachability | null;
  /** Set when the membership query failed. An empty list then means nothing. */
  membershipError?: string | null;
  /** Set when the stored predicate failed its safety check. */
  predicateError?: string | null;
}

export interface PushPlan {
  segmentId: string;
  externalId: string;
  isFirstPush: boolean;
  adds: string[];
  removes: string[];
  unchanged: string[];
  addBatches: string[][];
  removeBatches: string[][];
  /** `null` when reachability was not measured. Never 0 for "we didn't look". */
  reachability: Reachability | null;
  /** Non-empty means this plan must not be pushed. */
  blockers: string[];
}

/**
 * Addresses differing only in case or surrounding whitespace are the same
 * person. Treating them as different produces a remove and an add for someone
 * who never moved, and Attentive would be asked to drop and re-add them.
 */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}

function uniqueSorted(emails: string[]): string[] {
  return [...new Set(emails.map(normalise).filter((e) => e !== ""))].sort();
}

function batch(members: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < members.length; i += MAX_MEMBERS_PER_REQUEST) {
    out.push(members.slice(i, i + MAX_MEMBERS_PER_REQUEST));
  }
  return out;
}

export function computePushPlan(input: PushPlanInput): PushPlan {
  const current = uniqueSorted(input.currentMembers);
  const isFirstPush = input.lastPushedMembers === null;
  const previous = uniqueSorted(input.lastPushedMembers ?? []);
  const previousSet = new Set(previous);
  const currentSet = new Set(current);

  const adds = current.filter((e) => !previousSet.has(e));
  const removes = previous.filter((e) => !currentSet.has(e));
  const unchanged = current.filter((e) => previousSet.has(e));

  const blockers: string[] = [];

  // Fail closed. A read that errored produces an empty list, which is
  // indistinguishable from a segment that legitimately matched nobody — and
  // one of those should push while the other must not.
  if (input.membershipError) {
    blockers.push(
      `Membership could not be read: ${input.membershipError}. An empty result from a failed ` +
        `query looks exactly like a segment that matched nobody.`
    );
  }

  if (input.predicateError) {
    blockers.push(`The segment predicate failed its safety check: ${input.predicateError}.`);
  }

  if (current.length === 0) {
    blockers.push(
      previous.length > 0
        ? `This would empty a segment that currently holds ${previous.length} people. An empty ` +
          `result is the shape a broken predicate produces, so it is refused rather than sent.`
        : `The segment matched nobody, so there is nothing to push.`
    );
  } else if (adds.length === 0 && removes.length === 0) {
    // Not a failure — Attentive is already correct. But an empty bulk request
    // still returns a job id and would read as a push that happened.
    blockers.push(
      `Nothing to push: Attentive already matches this segment (${unchanged.length} members).`
    );
  }

  return {
    segmentId: input.segmentId,
    externalId: input.externalId,
    isFirstPush,
    adds,
    removes,
    unchanged,
    addBatches: batch(adds),
    removeBatches: batch(removes),
    reachability: input.reachability ?? null,
    blockers,
  };
}

export function canPush(plan: PushPlan): boolean {
  return plan.blockers.length === 0;
}

/**
 * A short, stable fingerprint of exactly what this plan would change.
 *
 * This is what makes "a human read the diff" structural rather than
 * procedural. It covers the target segment as well as the addresses, so
 * approving the lapsed diff cannot authorise pushing a different segment, and
 * it changes if a single address moves in or out.
 *
 * Twelve hex characters: long enough that it will not collide across the
 * handful of plans that exist, short enough to compare by eye in Slack.
 */
export function planToken(plan: PushPlan): string {
  const material = JSON.stringify({
    segmentId: plan.segmentId,
    externalId: plan.externalId,
    adds: plan.adds,
    removes: plan.removes,
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
