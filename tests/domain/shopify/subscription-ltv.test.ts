import { describe, it, expect } from "vitest";
import {
  computeCustomerLtv,
  computeLtvSummary,
  isSubscriptionOrder,
  type SubscriptionOrder,
} from "@/domain/shopify/subscription-ltv";

// Fixed "now" for determinism — no wall clock
const AS_OF = new Date("2025-07-01T00:00:00Z");

function makeOrders(
  customerId: string,
  dates: string[],
  priceCents = 800
): SubscriptionOrder[] {
  return dates.map((d) => ({
    customerId,
    orderCreatedAt: new Date(d),
    totalPriceCents: priceCents,
    isRecurring: true,
  }));
}

// ─── Tag detection ────────────────────────────────────────────────────

describe("isSubscriptionOrder: tag detection", () => {
  it("returns true when tags contain 'recurring-order'", () => {
    expect(isSubscriptionOrder(["sale", "recurring-order", "vip"])).toBe(true);
  });

  it("returns false when tags do not contain 'recurring-order'", () => {
    expect(isSubscriptionOrder(["sale", "vip"])).toBe(false);
  });

  it("returns false for empty tags", () => {
    expect(isSubscriptionOrder([])).toBe(false);
  });

  it("returns false for null/undefined tags", () => {
    expect(isSubscriptionOrder(null)).toBe(false);
    expect(isSubscriptionOrder(undefined)).toBe(false);
  });

  it("returns false for non-array tags", () => {
    expect(isSubscriptionOrder("recurring-order")).toBe(false);
  });
});

// ─── Customer LTV ─────────────────────────────────────────────────────

describe("computeCustomerLtv: individual customer", () => {
  it("computes LTV for a customer with 6 monthly orders", () => {
    const orders = makeOrders("cust_1", [
      "2025-01-15",
      "2025-02-15",
      "2025-03-15",
      "2025-04-15",
      "2025-05-15",
      "2025-06-15",
    ]);

    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF);
    expect(ltv).not.toBeNull();
    expect(ltv!.totalOrders).toBe(6);
    expect(ltv!.totalRevenueCents).toBe(4800); // 6 * 800
    expect(ltv!.firstOrderDate).toEqual(new Date("2025-01-15"));
    expect(ltv!.lastOrderDate).toEqual(new Date("2025-06-15"));
  });

  it("computes tenure in months between first and last order", () => {
    const orders = makeOrders("cust_1", ["2025-01-01", "2025-06-01"]);
    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF);
    expect(ltv!.tenureMonths).toBe(5);
  });

  it("computes average monthly revenue", () => {
    // 6 orders * $8 = $48 over 5 months tenure → $9.60/month
    const orders = makeOrders("cust_1", [
      "2025-01-15",
      "2025-02-15",
      "2025-03-15",
      "2025-04-15",
      "2025-05-15",
      "2025-06-15",
    ]);
    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF);
    // tenure = ~5 months, revenue = 4800 cents, avg = 960 cents/month
    expect(ltv!.avgMonthlyRevenueCents).toBe(960);
  });

  it("marks customer as churned when no order within threshold", () => {
    // Last order was 60 days ago, threshold is 45 days → churned
    const orders = makeOrders("cust_1", ["2025-01-15", "2025-05-01"]);
    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF, 45);
    expect(ltv!.isChurned).toBe(true);
  });

  it("marks customer as active when recent order within threshold", () => {
    const orders = makeOrders("cust_1", ["2025-01-15", "2025-06-20"]);
    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF, 45);
    expect(ltv!.isChurned).toBe(false);
  });

  it("returns null for customer with zero orders", () => {
    const ltv = computeCustomerLtv([], "cust_1", AS_OF);
    expect(ltv).toBeNull();
  });

  it("handles single order (tenure = 0 months)", () => {
    const orders = makeOrders("cust_1", ["2025-06-15"]);
    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF);
    expect(ltv!.totalOrders).toBe(1);
    expect(ltv!.tenureMonths).toBe(0);
    expect(ltv!.totalRevenueCents).toBe(800);
  });

  it("filters to only the specified customer", () => {
    const orders = [
      ...makeOrders("cust_1", ["2025-01-15", "2025-02-15"]),
      ...makeOrders("cust_2", ["2025-03-15"]),
    ];
    const ltv = computeCustomerLtv(orders, "cust_1", AS_OF);
    expect(ltv!.totalOrders).toBe(2);
  });
});

// ─── LTV Summary ──────────────────────────────────────────────────────

describe("computeLtvSummary: aggregate stats", () => {
  it("computes summary across multiple customers", () => {
    const orders = [
      // Customer 1: 6 months, active
      ...makeOrders("cust_1", [
        "2025-01-15", "2025-02-15", "2025-03-15",
        "2025-04-15", "2025-05-15", "2025-06-15",
      ]),
      // Customer 2: 3 months, churned (last order May 1)
      ...makeOrders("cust_2", [
        "2025-03-01", "2025-04-01", "2025-05-01",
      ]),
      // Customer 3: 2 months, active
      ...makeOrders("cust_3", [
        "2025-05-15", "2025-06-20",
      ]),
    ];

    const summary = computeLtvSummary(orders, AS_OF, 45);
    expect(summary.totalSubscribers).toBe(3);
    expect(summary.activeSubscribers).toBe(2);
    expect(summary.churnedSubscribers).toBe(1);
  });

  it("computes average tenure across subscribers", () => {
    const orders = [
      ...makeOrders("cust_1", ["2025-01-01", "2025-06-01"]), // 5 months
      ...makeOrders("cust_2", ["2025-04-01", "2025-06-01"]), // 2 months
    ];
    const summary = computeLtvSummary(orders, AS_OF, 45);
    // avg tenure = (5 + 2) / 2 = 3.5
    expect(summary.avgTenureMonths).toBe(3.5);
  });

  it("computes average LTV in cents", () => {
    const orders = [
      ...makeOrders("cust_1", ["2025-01-15", "2025-02-15", "2025-03-15"]), // 2400 cents
      ...makeOrders("cust_2", ["2025-04-15", "2025-05-15"]), // 1600 cents
    ];
    const summary = computeLtvSummary(orders, AS_OF, 45);
    // avg LTV = (2400 + 1600) / 2 = 2000 cents
    expect(summary.avgLtvCents).toBe(2000);
  });

  it("handles empty order list", () => {
    const summary = computeLtvSummary([], AS_OF);
    expect(summary.totalSubscribers).toBe(0);
    expect(summary.activeSubscribers).toBe(0);
    expect(summary.avgTenureMonths).toBe(0);
    expect(summary.avgLtvCents).toBe(0);
  });
});
