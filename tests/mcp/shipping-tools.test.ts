/**
 * The shipping tools once ShipHero gives per-order postage: shipping_costs'
 * shortfall compared like with like, margin_by_order_value on each order's
 * own label cost, and the two new tools for the threshold and for orders
 * whose label eats their revenue.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as economicsQueries from "@/domain/economics/queries";
import * as fulfilmentQueries from "@/domain/economics/fulfilment-queries";
import * as orderPostage from "@/domain/economics/order-postage";
import * as shipheroQueries from "@/domain/economics/shiphero-queries";
import type { FulfilmentModel } from "@/domain/economics/fulfilment-model";
import type { EconomicsOrder } from "@/domain/economics/queries";

vi.mock("@/domain/economics/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/queries")>()),
  getRateSettings: vi.fn(),
  getOrdersForEconomics: vi.fn(),
}));
vi.mock("@/domain/economics/fulfilment-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/fulfilment-queries")>()),
  loadFulfilmentModel: vi.fn(),
  getShipmentWindow: vi.fn(),
  getPostageByMethod: vi.fn(),
}));
vi.mock("@/domain/economics/order-postage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/order-postage")>()),
  getOrderPostage: vi.fn(),
  getPostageOverlap: vi.fn(),
}));
vi.mock("@/domain/economics/shiphero-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/economics/shiphero-queries")>()),
  getShipHeroCoverage: vi.fn(),
  getShipHeroRuns: vi.fn(),
}));

const ctx = { db: {} as never, now: () => new Date("2026-11-13T12:00:00Z") } as unknown as McpToolContext;

const model: FulfilmentModel = {
  rates: { handling: { perShippedOrderCents: 150, basis: "measured" }, postage: { perShippedOrderCents: 800, basis: "estimated" } },
  coverage: {
    handling: { from: "2026-08-22", to: "2026-10-30", daysInvoiced: 70, amountCents: 100_000, shippedOrders: 600 },
    postage: { from: "2026-08-31", to: "2026-10-25", daysInvoiced: 35, amountCents: 144_049, shippedOrders: 170, shipments: 164 },
  },
  fixedOverheadMonthlyCents: 55_000,
  notes: [],
} as unknown as FulfilmentModel;

const order = (id: string, subtotal: number, over: Partial<EconomicsOrder> = {}): EconomicsOrder => ({
  id, orderNumber: id.replace("gid://shopify/Order/", "RH"), subtotalCents: subtotal, discountCodes: [], orderedAt: "2026-10-01",
  totalPriceCents: subtotal, totalTaxCents: 0, productCostCents: 1000, lineRevenueCents: subtotal, costedLineRevenueCents: subtotal, shipped: true,
  ...over,
});

const known = (cents: number, source: "invoice" | "shiphero" = "shiphero") => ({ postage: { cents, source }, invoice: null, shiphero: null, weightLb: 2 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(economicsQueries.getRateSettings).mockResolvedValue({ paymentPctRate: 0.027, paymentFixedCents: 30 });
  vi.mocked(fulfilmentQueries.loadFulfilmentModel).mockResolvedValue(model);
  vi.mocked(economicsQueries.getOrdersForEconomics).mockResolvedValue([
    { line: "physical", orders: [order("gid://shopify/Order/1", 5500, { totalPriceCents: 6360 }), order("gid://shopify/Order/2", 6500), order("gid://shopify/Order/3", 6600)] },
    { line: "subscription", orders: [] },
    { line: "digital", orders: [] },
  ]);
  vi.mocked(orderPostage.getOrderPostage).mockResolvedValue(new Map([
    ["gid://shopify/Order/1", known(700, "invoice")],
    ["gid://shopify/Order/2", known(1100)],
  ]));
});

describe("shipping_costs", () => {
  // It subtracted shipping charged on ALL shipments from postage known on
  // only some: -195.21 where the like-for-like shortfall is 6,061.05.
  it("compares postage with what was charged on the same shipments only", async () => {
    vi.mocked(fulfilmentQueries.getShipmentWindow).mockResolvedValue({
      shipments: 2504, billed: 778, unbilled: 1726, knownCostCents: 980_638, chargedCents: 1_000_159,
      knownShipments: 778, chargedOnKnownCents: 374_533, firstShipment: "2025-09-22", lastShipment: "2026-09-21",
    });
    vi.mocked(fulfilmentQueries.getPostageByMethod).mockResolvedValue([]);
    const r = (await dispatchTool(ctx, "shipping_costs", {})) as Record<string, any>;
    expect(r.knownShortfallDollars).toBe(6061.05);
    expect(r.knownShortfallShipments).toBe(778);
    expect(r.shippingChargedOnKnownDollars).toBe(3745.33);
    expect(r.source).toMatch(/shipment export/i);
  });
});

describe("margin_by_order_value", () => {
  it("prices each order on its own label cost where known, and counts the fallbacks per band", async () => {
    const r = (await dispatchTool(ctx, "margin_by_order_value", {})) as Record<string, any>;
    const band = r.bands.find((b: any) => b.band === "$60-70");
    // Order 1 (total $63.60) and order 2 own a label cost; order 3 falls back.
    expect(band).toMatchObject({ orders: 3, postageKnownOrders: 2, postageFallbackOrders: 1 });
    expect(r.postageSources).toEqual({ invoice: 1, shiphero: 1, average: 1, none: 0 });
    expect(r.caveat).not.toMatch(/same in every band/);
    expect(r.caveat).toMatch(/1 of 3 shipped orders/);
  });
});

describe("free_shipping_threshold", () => {
  it("bands shipped physical orders on subtotal and compares $50-60 with $60-70", async () => {
    const r = (await dispatchTool(ctx, "free_shipping_threshold", { startDate: "2026-09-01", endDate: "2026-11-01" })) as Record<string, any>;
    expect(r.window).toEqual({ startDate: "2026-09-01", endDate: "2026-11-01" });
    expect(r.bandBasis).toMatch(/subtotal/i);
    expect(r.bands).toHaveLength(16);
    // Order 1 has a $55 subtotal and paid $8.60 shipping: below the threshold.
    expect(r.comparison.belowVsAbove.below).toMatchObject({ band: "$50-60", orders: 1, freeShippingShare: 0, avgShippingCharged: 8.6, avgLabelCost: 7 });
    expect(r.comparison.belowVsAbove.above).toMatchObject({ band: "$60-70", orders: 2, freeShippingShare: 1, avgLabelCost: 11, labelCostCoverage: 0.5 });
    expect(r.comparison.payingVsFree.paying.orders).toBe(1);
    expect(r.comparison.payingVsFree.free.orders).toBe(2);
    expect(r.coverage).toMatchObject({ orders: 3, ownLabelCost: 2, averageFallback: 1 });
  });

  it("refuses a range that ends before it starts", async () => {
    const r = (await dispatchTool(ctx, "free_shipping_threshold", { startDate: "2026-11-01", endDate: "2026-09-01" })) as Record<string, any>;
    expect(r.error).toMatch(/before/);
  });
});

describe("orders_shipping_over_share", () => {
  it("lists orders whose label cost is over 30% of net revenue by default, with their discount codes", async () => {
    vi.mocked(economicsQueries.getOrdersForEconomics).mockResolvedValue([
      { line: "physical", orders: [order("gid://shopify/Order/1", 2000, { discountCodes: ["FREESHIP"] }), order("gid://shopify/Order/2", 9000)] },
      { line: "subscription", orders: [] },
      { line: "digital", orders: [] },
    ]);
    vi.mocked(orderPostage.getOrderPostage).mockResolvedValue(new Map([["gid://shopify/Order/1", known(900)], ["gid://shopify/Order/2", known(900)]]));
    const r = (await dispatchTool(ctx, "orders_shipping_over_share", {})) as Record<string, any>;
    expect(r.share).toBe(0.3);
    expect(r.orders).toEqual([expect.objectContaining({ orderNumber: "RH1", labelCost: 9, netRevenue: 20, labelShare: 0.45, discountCodes: ["FREESHIP"], labelSource: "shiphero" })]);
    expect(r.byDiscountCode).toEqual([{ code: "FREESHIP", orders: 1, labelCost: 9, netRevenue: 20 }]);
    expect(r).toMatchObject({ judged: 2, unjudged: 0 });
  });
});

describe("shiphero_coverage", () => {
  it("reports coverage, the reconciliation against the invoice figures and the billing probe", async () => {
    vi.mocked(shipheroQueries.getShipHeroCoverage).mockResolvedValue({
      byMonth: [{ month: "2026-10", shipments: 10, labels: 10, includedLabels: 10, knownLabels: 9 }],
      byMonthAndCarrier: [], byCarrier: [], statuses: [{ status: "valid", refunded: false, labels: 10 }], unmatchedShipments: 0,
      shippingCharged: { orders: 0, agree: 0, disagree: 0, examples: [] },
    });
    vi.mocked(orderPostage.getPostageOverlap).mockResolvedValue({ orders: 4, identical: 3, meanDifferenceCents: 12, meanAbsoluteDifferenceCents: 12, overFiftyCents: 0, largest: [] });
    vi.mocked(shipheroQueries.getShipHeroRuns).mockResolvedValue({ lastSync: null, lastBillingProbe: { outcome: "no-access", errorMessage: "bills: code 7" } as never });
    const r = (await dispatchTool(ctx, "shiphero_coverage", {})) as Record<string, any>;
    expect(r.byMonth[0]).toMatchObject({ month: "2026-10", knownShare: 0.9 });
    expect(r.reconciliation).toMatchObject({ orders: 4, meanDifference: 0.12, overFiftyCents: 0 });
    expect(r.billing).toMatchObject({ readable: false });
  });
});
