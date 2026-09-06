import { describe, it, expect } from "vitest";
import {
  parseTierHistory,
  classifyLogEntry,
  toTierChangeFacts,
  type SealLogEntry,
} from "@/domain/subscriptions/tier-changes";

const e = (created: string, content: string): SealLogEntry => ({ created, content });

const ADD_STUDIO = 'Merchant added item "Really Awesome Doodles - Studio" to the subscription through the API.';
const RM_SPARK = 'Merchant removed item "Really Awesome Doodles Spark" from the subscription through the API.';
const ADD_SPARK = 'Merchant added item "Really Awesome Doodles - Spark" to the subscription through the API.';
const RM_STUDIO = 'Merchant removed item "Really Awesome Doodles Studio" from the subscription through the API.';

describe("classifyLogEntry", () => {
  it("reads the tier out of an added item", () => {
    expect(classifyLogEntry(ADD_STUDIO)).toEqual({ kind: "add", tier: "studio" });
  });

  it("reads the tier out of a removed item", () => {
    expect(classifyLogEntry(RM_SPARK)).toEqual({ kind: "remove", tier: "spark" });
  });

  it("reads the shorter non-API wording Seal also emits", () => {
    expect(classifyLogEntry('Merchant added "Really Awesome Doodles - Spark" to the subscription.')).toEqual({ kind: "add", tier: "spark" });
    expect(classifyLogEntry('Merchant removed "Really Awesome Doodles Studio" from the subscription.')).toEqual({ kind: "remove", tier: "studio" });
  });

  // The product rename touched 142 subscriptions. It changes the title on the
  // SAME item — nothing was added or removed and nobody's tier moved. Counting
  // these would triple the upgrade figure with pure noise. Nothing in the
  // classifier special-cases it; this pins the behaviour so that loosening the
  // add/remove patterns to catch a new phrasing cannot quietly swallow it.
  it("does not treat the Color Happy product rename as a tier change", () => {
    const rename = 'Automatically updated title of product "Really Awesome Doodles" to "Really Awesome Doodles Spark" via automatic title update.';
    expect(classifyLogEntry(rename)).toEqual({ kind: "other" });
  });

  it("recognises a merchant price change", () => {
    expect(classifyLogEntry('Merchant changed the price of item "Really Awesome Doodles - Studio" from  5.0 to 12.0')).toEqual({ kind: "price" });
  });

  it("recognises an automatic discount price change", () => {
    expect(classifyLogEntry('Automatically changed price of "Really Awesome Doodles - Spark" from 8.0 USD to 5.0 USD via automatic discount modification.')).toEqual({ kind: "price" });
  });

  it("ignores entries that have nothing to do with items or price", () => {
    expect(classifyLogEntry("Customer cancelled the subscription.")).toEqual({ kind: "other" });
    expect(classifyLogEntry("Merchant changed city in shipping address through the API.")).toEqual({ kind: "other" });
    expect(classifyLogEntry("Customer triggered a retry of a failed payment.")).toEqual({ kind: "other" });
  });

  // An unrecognised product must not be silently bucketed into a real tier —
  // a wrong tier is worse than an admitted unknown.
  it("reports an item whose product names no tier as unknown", () => {
    expect(classifyLogEntry('Merchant removed "Really Awesome Doodles" from the subscription.')).toEqual({ kind: "remove", tier: "unknown" });
  });

  it("does not throw on a template it has never seen", () => {
    expect(classifyLogEntry("Merchant did something entirely new.")).toEqual({ kind: "other" });
  });
});

describe("parseTierHistory", () => {
  it("finds no transitions in an empty log", () => {
    const h = parseTierHistory("s1", []);
    expect(h.transitions).toEqual([]);
    expect(h.netDirection).toBe("none");
  });

  // Seal always logs the add before the remove, so the item set is briefly
  // {Spark, Studio} rather than empty. Studio outranking Spark means that
  // transient never surfaces as a bogus extra transition.
  it("reads an add-then-remove pair as a single upgrade", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-13 22:50:20", ADD_STUDIO),
      e("2026-06-13 22:50:22", RM_SPARK),
    ]);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0].from).toBe("spark");
    expect(h.transitions[0].to).toBe("studio");
    expect(h.netDirection).toBe("upgrade");
  });

  it("reads the reverse pair as a single downgrade", () => {
    const h = parseTierHistory("s1", [
      e("2026-08-01 18:07:52", ADD_SPARK),
      e("2026-08-01 18:07:53", RM_STUDIO),
    ]);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0].from).toBe("studio");
    expect(h.transitions[0].to).toBe("spark");
    expect(h.netDirection).toBe("downgrade");
  });

  // Nothing records what the subscription started on. The only evidence is
  // that something was removed which was never added, so it must have been
  // there from the start.
  it("infers the starting tier from an item removed but never added", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-13 22:50:20", ADD_STUDIO),
      e("2026-06-13 22:50:22", RM_SPARK),
    ]);
    expect(h.initialTier).toBe("spark");
    expect(h.finalTier).toBe("studio");
  });

  it("timestamps the transition and reports it in UTC", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-13 22:50:20", ADD_STUDIO),
      e("2026-06-13 22:50:22", RM_SPARK),
    ]);
    expect(h.transitions[0].at).toBe("2026-06-13T22:50:20.000Z");
  });

  // Seal returns the log newest-first. Folding it in that order would invert
  // every upgrade into a downgrade.
  it("orders the log chronologically before folding it", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-13 22:50:22", RM_SPARK),
      e("2026-06-13 22:50:20", ADD_STUDIO),
    ]);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0].to).toBe("studio");
  });

  // One subscription was swapped back and forth eighteen times in 36 hours.
  // Counting each add as an upgrade would inflate the total; reporting only
  // the net would hide that a human needs to look at it.
  it("records every transition but reports net movement separately", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-21 02:17:26", ADD_STUDIO),
      e("2026-06-21 02:17:28", RM_SPARK),
      e("2026-06-21 02:26:42", ADD_SPARK),
      e("2026-06-21 02:26:44", RM_STUDIO),
      e("2026-06-21 02:34:16", ADD_STUDIO),
      e("2026-06-21 02:34:17", RM_SPARK),
    ]);
    expect(h.transitions).toHaveLength(3);
    expect(h.netDirection).toBe("upgrade");
    expect(h.churn).toBe(true);
  });

  it("does not flag a single clean change as churn", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-13 22:50:20", ADD_STUDIO),
      e("2026-06-13 22:50:22", RM_SPARK),
    ]);
    expect(h.churn).toBe(false);
  });

  it("reports no net movement when a subscription ends where it started", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-21 02:17:26", ADD_STUDIO),
      e("2026-06-21 02:17:28", RM_SPARK),
      e("2026-06-21 02:26:42", ADD_SPARK),
      e("2026-06-21 02:26:44", RM_STUDIO),
    ]);
    expect(h.initialTier).toBe("spark");
    expect(h.finalTier).toBe("spark");
    expect(h.netDirection).toBe("none");
    expect(h.churn).toBe(true);
  });

  // This is the 14076883 signature: the tier moved, the price did not.
  it("flags a tier change that carried no price change", () => {
    const h = parseTierHistory("s1", [
      e("2026-08-03 17:13:50", ADD_STUDIO),
      e("2026-08-03 17:13:52", RM_SPARK),
    ]);
    expect(h.transitions[0].priceChangeLogged).toBe(false);
  });

  it("does not flag a tier change that carried a price change", () => {
    const h = parseTierHistory("s1", [
      e("2026-08-03 17:13:50", ADD_STUDIO),
      e("2026-08-03 17:13:52", RM_SPARK),
      e("2026-08-03 17:13:54", 'Merchant changed the price of item "Really Awesome Doodles - Studio" from  5.0 to 12.0'),
    ]);
    expect(h.transitions[0].priceChangeLogged).toBe(true);
  });

  // A price edit made weeks later is a separate merchant action, not part of
  // this change. Attributing it here would mask a real unpriced upgrade.
  it("does not credit a price change made long after the tier moved", () => {
    const h = parseTierHistory("s1", [
      e("2026-08-03 17:13:50", ADD_STUDIO),
      e("2026-08-03 17:13:52", RM_SPARK),
      e("2026-08-20 09:00:00", 'Merchant changed the price of item "Really Awesome Doodles - Studio" from  5.0 to 12.0'),
    ]);
    expect(h.transitions[0].priceChangeLogged).toBe(false);
  });

  it("ignores unrelated entries between the add and the remove", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-13 22:50:20", ADD_STUDIO),
      e("2026-06-13 22:50:21", "Merchant changed city in shipping address through the API."),
      e("2026-06-13 22:50:22", RM_SPARK),
    ]);
    expect(h.transitions).toHaveLength(1);
    expect(h.transitions[0].to).toBe("studio");
  });

  it("stays deterministic when two entries share a timestamp", () => {
    const entries = [
      e("2026-06-13 22:50:20", ADD_STUDIO),
      e("2026-06-13 22:50:20", RM_SPARK),
    ];
    const a = parseTierHistory("s1", entries);
    const b = parseTierHistory("s1", [...entries].reverse());
    expect(a.transitions).toEqual(b.transitions);
  });

  // A log with only renames and cancellations must not invent a starting tier
  // it has no evidence for.
  it("leaves the tier unknown when the log says nothing about items", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-16 01:10:34", "Merchant changed city in shipping address through the API."),
      e("2026-09-01 17:49:45", "Customer cancelled the subscription."),
    ]);
    expect(h.initialTier).toBe("unknown");
    expect(h.finalTier).toBe("unknown");
    expect(h.transitions).toEqual([]);
  });

  it("does not count a move into or out of an unknown tier as an upgrade", () => {
    const h = parseTierHistory("s1", [
      e("2026-06-08 18:13:20", ADD_STUDIO),
      e("2026-06-08 18:13:26", 'Merchant removed "Really Awesome Doodles" from the subscription.'),
    ]);
    expect(h.netDirection).toBe("none");
  });
});

describe("toTierChangeFacts", () => {
  const row = (o: Partial<{ id: string; pricingCohort: string; log: unknown }> = {}) => ({
    id: "s1",
    pricingCohort: "grandfathered",
    log: [
      { created: "2026-06-13 22:50:20", content: ADD_STUDIO },
      { created: "2026-06-13 22:50:22", content: RM_SPARK },
    ] as unknown,
    ...o,
  });

  it("flattens one row's transitions into facts", () => {
    expect(toTierChangeFacts([row()])).toEqual([
      {
        subscriptionId: "s1",
        at: "2026-06-13T22:50:20.000Z",
        from: "spark",
        to: "studio",
        pricingCohort: "grandfathered",
      },
    ]);
  });

  it("carries each row's own cohort onto its facts", () => {
    const facts = toTierChangeFacts([row(), row({ id: "s2", pricingCohort: "current" })]);
    expect(facts.map((f) => f.pricingCohort)).toEqual(["grandfathered", "current"]);
  });

  // Only the rows the detail crawl reached have a log. A row it never fetched
  // must contribute nothing rather than throw — the crawl is resumable, so a
  // partially-backfilled table is a normal state, not a broken one.
  it("skips a row whose log was never fetched", () => {
    expect(toTierChangeFacts([row({ log: null })])).toEqual([]);
  });

  // jsonb is untyped at the boundary. A shape we cannot read must not be
  // silently folded into a transition we then report as fact.
  it("skips log shapes it cannot read", () => {
    expect(toTierChangeFacts([row({ log: "not an array" })])).toEqual([]);
    expect(toTierChangeFacts([row({ log: [{ created: 1, content: 2 }] })])).toEqual([]);
    expect(toTierChangeFacts([row({ log: [null] })])).toEqual([]);
  });

  it("keeps the readable entries when one entry in a log is malformed", () => {
    const facts = toTierChangeFacts([
      row({
        log: [
          { created: "2026-06-13 22:50:20", content: ADD_STUDIO },
          null,
          { created: "2026-06-13 22:50:22", content: RM_SPARK },
        ],
      }),
    ]);
    expect(facts).toHaveLength(1);
    expect(facts[0].to).toBe("studio");
  });

  it("returns no facts for a row whose log holds no tier change", () => {
    expect(toTierChangeFacts([row({ log: [{ created: "2026-06-13 22:50:20", content: "Customer cancelled the subscription." }] })])).toEqual([]);
  });
});
