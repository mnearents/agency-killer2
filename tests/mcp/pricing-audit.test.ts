/**
 * `subscription_pricing_audit` at its call site.
 *
 * The assessment is covered in `tests/domain/subscriptions/pricing.test.ts`.
 * What is asserted here is that the tool is registered, that it carries the
 * `priceAnomaly` flag through — without it the corrupt/real split silently
 * collapses and the headline becomes a mass overbilling that is not happening
 * — and that money crosses the boundary in dollars.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALL_TOOLS, dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as subscriptionQueries from "@/domain/subscriptions/queries";
import type { SubscriptionFact } from "@/domain/subscriptions/analytics";

vi.mock("@/domain/subscriptions/queries", () => ({
  getSubscriptionFacts: vi.fn(),
  getSnapshotFacts: vi.fn().mockResolvedValue([]),
  getTierChangeFacts: vi.fn().mockResolvedValue([]),
}));

const ctx = {
  db: {} as never,
  now: () => new Date("2026-09-18T12:00:00Z"),
} as unknown as McpToolContext;

const fact = (over: Partial<SubscriptionFact> = {}): SubscriptionFact => ({
  id: "1",
  status: "ACTIVE",
  tier: "spark",
  pricingCohort: "grandfathered",
  billingInterval: "1 month",
  billingCadence: "monthly",
  priceCents: 500,
  priceAnomaly: false,
  inDunning: false,
  manualOrigin: false,
  orderPlaced: new Date("2026-06-01"),
  cancelledOn: null,
  ...over,
});

type Audit = {
  assessed: number;
  onGrid: number;
  offGridCount: number;
  monthlyUndercharge: number;
  monthlyOvercharge: number;
  monthlyOverchargeExcludingCorrupt: number;
  annualisedUndercharge: number;
  offGrid: Array<{ id: string; verdict: string; expected: number; actual: number; monthlyImpact: number; alsoPriceAnomaly: boolean }>;
  unpriceable: Array<{ id: string; verdict: string }>;
};

beforeEach(() => vi.clearAllMocks());

describe("subscription_pricing_audit is reachable", () => {
  it("is in the tool list", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain("subscription_pricing_audit");
  });
});

describe("subscription_pricing_audit", () => {
  /** Subscription 14101980, the case #8 was filed for: $12/yr against $120. */
  it("catches the undercharge the 2x test could not see", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ id: "14101980", tier: "studio", billingInterval: "12 month", billingCadence: "annual", priceCents: 1200 }),
    ]);
    const r = (await dispatchTool(ctx, "subscription_pricing_audit", {})) as Audit;
    expect(r.offGridCount).toBe(1);
    expect(r.offGrid[0].verdict).toBe("undercharge");
    expect(r.offGrid[0].expected).toBe(120);
    expect(r.offGrid[0].actual).toBe(12);
  });

  it("reports money in dollars, never cents", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ id: "u", tier: "studio", priceCents: 500 }),
    ]);
    const r = (await dispatchTool(ctx, "subscription_pricing_audit", {})) as Audit;
    expect(r.offGrid[0].expected).toBe(12);
    expect(r.monthlyUndercharge).toBe(7);
    expect(r.annualisedUndercharge).toBe(84);
  });

  /**
   * The flag has to survive the trip from the fact into the summary. Without
   * it every corrupt row counts as a customer being overbilled, and against
   * production that turns $116 a month into $2,770.
   */
  it("carries priceAnomaly through, so corrupt rows stay separable", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ id: "corrupt", priceCents: 1_938_200, priceAnomaly: true }),
      fact({ id: "real", priceCents: 700 }),
    ]);
    const r = (await dispatchTool(ctx, "subscription_pricing_audit", {})) as Audit;
    expect(r.monthlyOverchargeExcludingCorrupt).toBe(2);
    expect(r.monthlyOvercharge).toBeGreaterThan(19000);
    expect(r.offGrid.find((o) => o.id === "corrupt")!.alsoPriceAnomaly).toBe(true);
    expect(r.offGrid.find((o) => o.id === "real")!.alsoPriceAnomaly).toBe(false);
  });

  it("lists a zero price rather than treating it as a cheap plan", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([
      fact({ id: "zero", priceCents: 0 }),
    ]);
    const r = (await dispatchTool(ctx, "subscription_pricing_audit", {})) as Audit;
    expect(r.unpriceable).toEqual([expect.objectContaining({ id: "zero", verdict: "non-positive" })]);
    expect(r.offGridCount).toBe(0);
  });

  it("says nothing is wrong when nothing is", async () => {
    vi.mocked(subscriptionQueries.getSubscriptionFacts).mockResolvedValue([fact(), fact({ id: "2" })]);
    const r = (await dispatchTool(ctx, "subscription_pricing_audit", {})) as Audit;
    expect(r.onGrid).toBe(2);
    expect(r.offGridCount).toBe(0);
    expect(r.monthlyUndercharge).toBe(0);
  });

  /**
   * The description is the only place a caller learns not to quote the gross
   * overcharge, and it is the number most likely to be quoted.
   */
  it("warns in its own description which overcharge figure to read", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "subscription_pricing_audit")!;
    expect(tool.description).toMatch(/monthlyOverchargeExcludingCorrupt/);
    expect(tool.description).toMatch(/not the gross overcharge/i);
  });

  it("says it is not priceAnomaly, and why", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "subscription_pricing_audit")!;
    expect(tool.description).toMatch(/NOT `priceAnomaly`/);
    expect(tool.description).toMatch(/belongs in MRR/);
  });
});
