/**
 * `target_cpa` at its call site.
 *
 * The pure functions are covered in `tests/domain/economics/target-cpa.test.ts`
 * and pass whether or not anything invokes them. What is asserted here is the
 * wiring: that the tool is registered, that the subscription line is priced off
 * the CHURNED cohort, and that a subscription cohort never reaches a physical
 * line. #59 shipped wiring tests that survived a mutation disabling the guard
 * entirely, so the fixtures below make the three cohorts produce three
 * different numbers — a fixture set where they agree passes against all of them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALL_TOOLS, dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as subscriptionQueries from "@/domain/subscriptions/queries";
import * as economicsQueries from "@/domain/economics/queries";
import type { SubscriptionFact } from "@/domain/subscriptions/analytics";

vi.mock("@/domain/subscriptions/queries", () => ({
  getSubscriptionFacts: vi.fn().mockResolvedValue([]),
  getSnapshotFacts: vi.fn().mockResolvedValue([]),
  getTierChangeFacts: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/domain/economics/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/economics/queries")>();
  return {
    ...actual,
    getRateSettings: vi.fn(),
    getOrdersForEconomics: vi.fn(),
  };
});

const NOW = new Date("2026-04-01T00:00:00Z");
const ctx = { db: {} as never, now: () => NOW } as unknown as McpToolContext;

const fact = (over: Partial<SubscriptionFact> = {}): SubscriptionFact => ({
  id: Math.random().toString(),
  status: "CANCELLED",
  tier: "spark",
  pricingCohort: "current",
  billingInterval: "1 month",
  billingCadence: "monthly",
  priceCents: 800,
  priceAnomaly: false,
  inDunning: false,
  manualOrigin: false,
  orderPlaced: new Date("2026-01-01"),
  cancelledOn: new Date("2026-02-01"),
  ...over,
});

/** Churned observed → $16. Active observed → $24. Churned migrated → $40. */
const THREE_COHORTS: SubscriptionFact[] = [
  fact({}),
  fact({ status: "ACTIVE", cancelledOn: null }),
  fact({ manualOrigin: true, orderPlaced: new Date("2025-10-01"), cancelledOn: new Date("2026-02-01") }),
];

const order = (totalPriceCents: number) => ({
  totalPriceCents,
  totalTaxCents: 0,
  productCostCents: 0,
  costIsKnown: true,
});

beforeEach(() => {
  vi.mocked(economicsQueries.getRateSettings).mockResolvedValue({
    paymentPctRate: 0.027,
    paymentFixedCents: 30,
  });
  vi.mocked(economicsQueries.getOrdersForEconomics).mockResolvedValue([
    { line: "subscription", orders: [order(800)] },
    { line: "digital", orders: [order(1200)] },
    { line: "physical", orders: [order(4500)] },
  ]);
  vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue(THREE_COHORTS);
});

describe("target_cpa is reachable", () => {
  // A tool that exists and is not registered is a tool Claude Desktop cannot
  // call, and it reports identically to one that was never written.
  it("is in the tool list", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain("target_cpa");
  });
});

describe("target_cpa: the cohort it prices subscriptions off", () => {
  it("uses the churned observed LTV, not the active or migrated one", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", { businessLine: "subscription" })) as {
      lines: Array<{ bases: Array<{ basis: string; valuePerCustomer: number }> }>;
    };
    const lifetime = r.lines[0].bases.find((b) => b.basis === "realised-churned-ltv");
    expect(lifetime, "no lifetime basis on the subscription line").toBeDefined();
    // $16 is churned observed. $24 is active, $40 migrated — both wrong here.
    expect(lifetime!.valuePerCustomer).toBe(16);
  });

  it("reports the cohort it used alongside the figures", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", {})) as {
      subscriptionLtv: { cohort: string; subscribers: number; avgLtv: number; unfinishedRuns: number };
    };
    expect(r.subscriptionLtv.cohort).toBe("churned-observed");
    expect(r.subscriptionLtv.subscribers).toBe(1);
    expect(r.subscriptionLtv.avgLtv).toBe(16);
    // The active run and the migrated active — both unfinished against this window.
    expect(r.subscriptionLtv.unfinishedRuns).toBe(1);
  });

  it("does not price a physical line off the subscription cohort", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", { businessLine: "physical" })) as {
      lines: Array<{ bases: Array<{ basis: string }>; blockers: string[] }>;
    };
    expect(r.lines[0].bases.map((b) => b.basis)).toEqual(["first-order"]);
    expect(r.lines[0].blockers).toEqual([]);
  });

  it("says so rather than guessing when no run has finished", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ status: "ACTIVE", cancelledOn: null }),
    ]);
    const r = (await dispatchTool(ctx, "target_cpa", { businessLine: "subscription" })) as {
      subscriptionLtv: unknown;
      subscriptionLtvNote?: string;
      lines: Array<{ bases: Array<{ basis: string }>; blockers: string[] }>;
    };
    expect(r.subscriptionLtv).toBeNull();
    expect(r.subscriptionLtvNote).toMatch(/could not be computed/);
    expect(r.lines[0].bases.map((b) => b.basis)).toEqual(["first-order"]);
    expect(r.lines[0].blockers.join(" ")).toMatch(/no finished subscription/i);
  });

  it("returns every line when none is named", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", {})) as { lines: Array<{ businessLine: string }> };
    expect(r.lines.map((l) => l.businessLine)).toEqual(["subscription", "digital", "physical"]);
  });
});

describe("target_cpa: inputs it refuses to substitute for", () => {
  // Substituting 0.027 would produce a CPA that looks computed and is assumed.
  it("errors rather than defaulting when no payment rate is in effect", async () => {
    vi.mocked(economicsQueries.getRateSettings).mockResolvedValue(null);
    const r = (await dispatchTool(ctx, "target_cpa", {})) as { error?: string; lines?: unknown };
    expect(r.error).toMatch(/No payment rates are in effect/);
    expect(r.lines).toBeUndefined();
  });

  it("rejects an unknown argument instead of ignoring it", async () => {
    await expect(dispatchTool(ctx, "target_cpa", { line: "physical" })).rejects.toThrow(
      /Unknown argument.*line/
    );
  });

  it("rejects a business line that is not one of the three", async () => {
    await expect(dispatchTool(ctx, "target_cpa", { businessLine: "wholesale" })).rejects.toThrow(
      /businessLine/
    );
  });
});

describe("target_cpa: the caveats reach the caller", () => {
  it("names the missing fulfilment cost at the top level", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", {})) as { caveat: string };
    expect(r.caveat).toMatch(/Fulfilment/);
  });

  it("names contribution as what the ratio is taken over", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", {})) as {
      ratio: string;
      lines: Array<{ ratioBasis: string }>;
    };
    expect(r.ratio).toMatch(/3:1/);
    expect(r.ratio).toMatch(/contribution/);
    expect(r.lines[0].ratioBasis).toBe("contribution");
  });
});
