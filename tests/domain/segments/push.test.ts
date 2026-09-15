/**
 * The push plan: what would change in Attentive, computed before anything is
 * sent, and the thing a human actually approves.
 *
 * ## Why the diff comes from our own history
 *
 * Attentive exposes no way to read segment membership back — that is why #23
 * inverted into #32 in the first place. So "what is in the segment right now"
 * is not knowable from Attentive, and the only possible basis for a diff is a
 * record of what we last pushed. Without that history, removals cannot be
 * computed at all, and a segment we only ever add to goes wrong the moment
 * someone resubscribes.
 *
 * ## Why the push re-derives the plan
 *
 * If a push tool accepted a list of addresses, every guarantee here would be
 * advisory — the caller could simply pass a different list. So the push
 * recomputes the plan itself and takes a token derived from the diff the human
 * was shown. A token that no longer matches means the data moved underneath
 * the approval, and the answer is a fresh dry-run, not a push.
 */

import { describe, it, expect } from "vitest";
import {
  computePushPlan,
  planToken,
  canPush,
  type PushPlan,
} from "@/domain/segments/push";

const plan = (current: string[], lastPushed: string[] | null, opts = {}) =>
  computePushPlan({
    segmentId: "lapsed_12_to_24m",
    externalId: "lapsed_12_to_24m",
    currentMembers: current,
    lastPushedMembers: lastPushed,
    ...opts,
  });

describe("computePushPlan: the diff", () => {
  it("treats a first push as all adds and no removes", () => {
    const p = plan(["a@x.com", "b@x.com"], null);
    expect(p.adds).toEqual(["a@x.com", "b@x.com"]);
    expect(p.removes).toEqual([]);
    expect(p.isFirstPush).toBe(true);
  });

  /**
   * "Never pushed" and "pushed, nothing changed" produce the same empty
   * removes list and would produce the same adds list on an unchanged segment.
   * They are different facts: one means Attentive has nothing, the other means
   * Attentive is already correct.
   */
  it("distinguishes a first push from a push that changes nothing", () => {
    const first = plan(["a@x.com"], null);
    const noop = plan(["a@x.com"], ["a@x.com"]);
    expect(first.isFirstPush).toBe(true);
    expect(noop.isFirstPush).toBe(false);
    expect(first.adds).toEqual(["a@x.com"]);
    expect(noop.adds).toEqual([]);
    expect(noop.unchanged).toEqual(["a@x.com"]);
  });

  it("computes adds, removes and unchanged against the last push", () => {
    const p = plan(["a@x.com", "c@x.com"], ["a@x.com", "b@x.com"]);
    expect(p.adds).toEqual(["c@x.com"]);
    expect(p.removes).toEqual(["b@x.com"]);
    expect(p.unchanged).toEqual(["a@x.com"]);
  });

  /**
   * Removals are the half that only exists because of the history. A segment
   * that is only ever added to is wrong the moment someone resubscribes, and
   * they keep receiving win-back campaigns as a paying customer.
   */
  it("removes someone who no longer matches the definition", () => {
    const p = plan([], ["resubscribed@x.com"]);
    expect(p.removes).toEqual(["resubscribed@x.com"]);
    expect(p.adds).toEqual([]);
  });

  // Addresses differing only in case are the same person. Treating them as
  // different produces a remove and an add for someone who never moved.
  it("matches addresses case-insensitively and normalises whitespace", () => {
    const p = plan([" A@X.com "], ["a@x.com"]);
    expect(p.adds).toEqual([]);
    expect(p.removes).toEqual([]);
    expect(p.unchanged).toHaveLength(1);
  });

  it("deduplicates rather than pushing the same person twice", () => {
    const p = plan(["a@x.com", "A@x.com", "a@x.com"], null);
    expect(p.adds).toEqual(["a@x.com"]);
  });

  it("is deterministic — the same inputs in any order give the same plan", () => {
    const one = plan(["b@x.com", "a@x.com"], ["c@x.com"]);
    const two = plan(["a@x.com", "b@x.com"], ["c@x.com"]);
    expect(one.adds).toEqual(two.adds);
    expect(planToken(one)).toBe(planToken(two));
  });
});

describe("blockers: a plan that cannot be established cannot be pushed", () => {
  it("allows a plan with real changes", () => {
    const p = plan(["a@x.com"], null);
    expect(p.blockers).toEqual([]);
    expect(canPush(p)).toBe(true);
  });

  /**
   * An empty segment is the shape a broken predicate produces. Pushing it
   * would remove everyone from the segment in Attentive, which is a large,
   * silent, hard-to-notice change made by a query that returned nothing.
   */
  it("blocks a push that would empty a segment that previously had members", () => {
    const p = plan([], ["a@x.com", "b@x.com"]);
    expect(canPush(p)).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/empt/i);
  });

  it("blocks a first push with no members at all", () => {
    const p = plan([], null);
    expect(canPush(p)).toBe(false);
  });

  // Nothing to do is not a failure, but it must not be sent either — an
  // empty bulk request returns a job id and reads as a push that happened.
  it("blocks a push that would change nothing, and says why", () => {
    const p = plan(["a@x.com"], ["a@x.com"]);
    expect(canPush(p)).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/nothing to (push|change)/i);
  });

  /**
   * Fail closed. A membership read that errored produces an empty list, which
   * is indistinguishable from a segment that legitimately matched nobody —
   * and one of those should push while the other must not.
   */
  it("blocks when the membership could not be read at all", () => {
    const p = plan(["a@x.com"], null, { membershipError: "connection reset" });
    expect(canPush(p)).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/connection reset/);
  });

  it("blocks an unsafe segment predicate rather than interpolating it", () => {
    const p = plan(["a@x.com"], null, { predicateError: "contains a comment marker" });
    expect(canPush(p)).toBe(false);
  });

  it("reports every blocker, not just the first", () => {
    const p = plan([], null, { membershipError: "boom" });
    expect(p.blockers.length).toBeGreaterThan(1);
  });
});

describe("reachability is reported, and its absence is not zero", () => {
  it("carries the marketing-reachable count when it was measured", () => {
    const p = plan(["a@x.com", "b@x.com"], null, {
      reachability: { checked: 2, known: 2, marketingEligible: 1 },
    });
    expect(p.reachability).toEqual({ checked: 2, known: 2, marketingEligible: 1 });
  });

  /**
   * "12,232 in the segment" and "10,600 who can actually receive a marketing
   * message" are different numbers, and the second is the one that predicts
   * what a send does. Unmeasured must read as unmeasured, never as zero.
   */
  it("reports null rather than zero when reachability was not measured", () => {
    expect(plan(["a@x.com"], null).reachability).toBeNull();
  });

  // Not a blocker: reachability is information for the human, and a segment
  // is still worth pushing when we did not stop to measure it.
  it("does not block a push merely because reachability is unmeasured", () => {
    expect(canPush(plan(["a@x.com"], null))).toBe(true);
  });
});

/**
 * The token is what makes "a human read the diff" structural rather than
 * procedural. It is derived from the adds and removes, so approving one diff
 * cannot authorise a different one.
 */
describe("planToken", () => {
  const base = () => plan(["a@x.com", "b@x.com"], ["c@x.com"]);

  it("is stable for the same diff", () => {
    expect(planToken(base())).toBe(planToken(base()));
  });

  it("changes when an address is added to the diff", () => {
    expect(planToken(plan(["a@x.com", "b@x.com", "d@x.com"], ["c@x.com"]))).not.toBe(
      planToken(base())
    );
  });

  it("changes when a removal appears", () => {
    expect(planToken(plan(["a@x.com", "b@x.com"], ["c@x.com", "e@x.com"]))).not.toBe(
      planToken(base())
    );
  });

  // Approving the lapsed segment must not authorise pushing a different one.
  it("changes when the same diff targets a different segment", () => {
    const other = computePushPlan({
      segmentId: "high_value",
      externalId: "high_value",
      currentMembers: ["a@x.com", "b@x.com"],
      lastPushedMembers: ["c@x.com"],
    });
    expect(planToken(other)).not.toBe(planToken(base()));
  });

  it("is short enough for a person to compare by eye", () => {
    expect(planToken(base())).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe("batching for the API's 10,000 cap", () => {
  it("splits a list that exceeds the cap and covers every member exactly once", () => {
    const members = Array.from({ length: 25_000 }, (_, i) => `p${i}@x.com`);
    const p = plan(members, null);
    expect(p.addBatches).toHaveLength(3);
    expect(p.addBatches.flat()).toHaveLength(25_000);
    expect(new Set(p.addBatches.flat()).size).toBe(25_000);
    for (const b of p.addBatches) expect(b.length).toBeLessThanOrEqual(10_000);
  });

  it("produces no batch at all when there is nothing to send", () => {
    const p = plan(["a@x.com"], ["a@x.com"]);
    expect(p.addBatches).toEqual([]);
    expect(p.removeBatches).toEqual([]);
  });

  it("batches removals too", () => {
    const old = Array.from({ length: 12_000 }, (_, i) => `p${i}@x.com`);
    const p = plan([], old);
    expect(p.removeBatches).toHaveLength(2);
    expect(p.removeBatches.flat()).toHaveLength(12_000);
  });
});
