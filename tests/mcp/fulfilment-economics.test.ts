/**
 * The margin tools at their call sites, once fulfilment is invoiced.
 *
 * Each said "Fulfilment is not yet in the database ... every margin a
 * ceiling" as a fixed string. Now the invoices are loaded, so the costs must
 * reach the arithmetic and the caveat must reflect what is actually held.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as economicsQueries from "@/domain/economics/queries";
import * as fulfilmentQueries from "@/domain/economics/fulfilment-queries";
import type { FulfilmentModel } from "@/domain/economics/fulfilment-model";

vi.mock("@/domain/economics/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/queries")>()),
  getRateSettings: vi.fn(),
  getOrdersForEconomics: vi.fn(),
  getNewCustomerOrders: vi.fn(),
  getAdSpend: vi.fn(),
}));
vi.mock("@/domain/economics/fulfilment-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/fulfilment-queries")>()),
  loadFulfilmentModel: vi.fn(),
}));
vi.mock("@/domain/subscriptions/queries", () => ({ getSubscriptionFacts: vi.fn().mockResolvedValue([]) }));

const ctx = { db: {} as never, now: () => new Date("2026-10-30T12:00:00Z") } as unknown as McpToolContext;

const shippedOrder = (totalPriceCents: number) => ({
  totalPriceCents, totalTaxCents: 0, productCostCents: 1000, lineRevenueCents: totalPriceCents, costedLineRevenueCents: totalPriceCents, shipped: true,
});

const model = (basis: "measured" | "estimated"): FulfilmentModel => ({
  rates: { handling: { perShippedOrderCents: 150, basis }, postage: { perShippedOrderCents: 800, basis } },
  coverage: {
    handling: { from: "2026-08-22", to: "2026-10-30", daysInvoiced: 70, amountCents: 100_000, shippedOrders: 600 },
    postage: { from: "2026-08-31", to: "2026-10-25", daysInvoiced: 35, amountCents: 144_049, shippedOrders: 170, shipments: 164 },
  },
  fixedOverheadMonthlyCents: 55_000,
  notes: basis === "estimated" ? ["Postage is an average from invoiced days applied beyond them: 20 of the window's 30 days have no invoice."] : [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(economicsQueries.getRateSettings).mockResolvedValue({ paymentPctRate: 0.027, paymentFixedCents: 30 });
  vi.mocked(economicsQueries.getOrdersForEconomics).mockResolvedValue([
    { line: "subscription", orders: [] },
    { line: "digital", orders: [] },
    { line: "physical", orders: [shippedOrder(6500)] },
  ]);
  vi.mocked(economicsQueries.getNewCustomerOrders).mockResolvedValue({
    byLine: [{ line: "physical", orders: [shippedOrder(6500)] }, { line: "subscription", orders: [] }, { line: "digital", orders: [] }],
    undecidableOrders: 0,
  });
  vi.mocked(economicsQueries.getAdSpend).mockResolvedValue([{ channel: "meta", spendCents: 1000, daysWithSpend: 1 }]);
  vi.mocked(fulfilmentQueries.loadFulfilmentModel).mockResolvedValue(model("measured"));
});

describe("unit_economics with invoiced fulfilment", () => {
  it("puts handling and postage into the cost of delivery and drops the ceiling caveat", async () => {
    const r = (await dispatchTool(ctx, "unit_economics", { businessLine: "physical" })) as Record<string, any>;
    const physical = r.lines[0];
    expect(physical.components).toEqual(expect.arrayContaining([
      { label: "Fulfilment handling (pick/pack, packaging, returns)", amount: 1.5, basis: "measured" },
      { label: "Postage (shipping labels)", amount: 8, basis: "measured" },
    ]));
    expect(physical.complete).toBe(true);
    expect(r.caveat).toBeUndefined();
    expect(r.fulfilment).toMatchObject({ handlingPerShippedOrder: 1.5, postagePerShippedOrder: 8, fixedOverheadPerMonth: 550 });
  });

  it("says when the rates are averages applied beyond the invoiced days", async () => {
    vi.mocked(fulfilmentQueries.loadFulfilmentModel).mockResolvedValue(model("estimated"));
    const r = (await dispatchTool(ctx, "unit_economics", { businessLine: "physical" })) as Record<string, any>;
    expect(r.caveat).toMatch(/estimate/i);
    expect(r.lines[0].estimated).toContain("Postage (shipping labels)");
  });

  it("keeps the floor caveat when nothing is invoiced", async () => {
    vi.mocked(fulfilmentQueries.loadFulfilmentModel).mockResolvedValue({
      rates: { handling: null, postage: null }, coverage: { handling: null, postage: null }, fixedOverheadMonthlyCents: null, notes: [],
    });
    const r = (await dispatchTool(ctx, "unit_economics", { businessLine: "physical" })) as Record<string, any>;
    expect(r.caveat).toMatch(/floor/);
    expect(r.lines[0].complete).toBe(false);
  });
});

describe("margin_by_order_value with invoiced fulfilment", () => {
  it("takes handling and postage out of each band and is no longer provisional for want of labels", async () => {
    const r = (await dispatchTool(ctx, "margin_by_order_value", {})) as Record<string, any>;
    const band = r.bands.find((b: { band: string }) => b.band === "$60-70");
    expect(band.fulfilment).toBe(9.5);
    expect(r.caveat ?? "").not.toMatch(/not in the database/);
  });
});

describe("target_cpa with invoiced fulfilment", () => {
  it("is not called a ceiling for missing fulfilment once it is invoiced", async () => {
    const r = (await dispatchTool(ctx, "target_cpa", { businessLine: "physical" })) as Record<string, any>;
    const reasons = r.lines[0].bases.flatMap((b: { boundReasons: string[] }) => b.boundReasons).join(" ");
    expect(reasons).not.toMatch(/Fulfilment/);
    expect(r.caveat).toBeUndefined();
  });
});

describe("amer with invoiced fulfilment", () => {
  it("counts handling and postage in break-even", async () => {
    const r = (await dispatchTool(ctx, "amer", {})) as Record<string, any>;
    expect(JSON.stringify(r)).not.toMatch(/Fulfilment \(3PL labels/);
    expect(vi.mocked(fulfilmentQueries.loadFulfilmentModel)).toHaveBeenCalled();
  });
});
