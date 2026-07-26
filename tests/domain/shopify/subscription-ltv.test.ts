import { describe, it, expect } from "vitest";
import {
  computeCustomerLtv,
  computeLtvSummary,
  isSubscriptionOrder,
  classifyOrder,
  type SubscriptionOrder,
} from "@/domain/shopify/subscription-ltv";

const AS_OF = new Date("2025-07-01T00:00:00Z");

function makeOrder(
  customerId: string,
  date: string,
  priceCents: number
): SubscriptionOrder {
  return {
    customerId,
    orderCreatedAt: new Date(date),
    totalPriceCents: priceCents,
    isRecurring: true,
  };
}

// ─── Tag detection ────────────────────────────────────────────────────

describe("isSubscriptionOrder: tag detection", () => {
  it("returns true for 'recurring-order'", () => {
    expect(isSubscriptionOrder(["recurring-order"])).toBe(true);
  });

  it("returns true for 'colorhappy-first'", () => {
    expect(isSubscriptionOrder(["colorhappy-first"])).toBe(true);
  });

  it("returns true for 'rad-first'", () => {
    expect(isSubscriptionOrder(["rad-first"])).toBe(true);
  });

  it("returns false for non-subscription tags", () => {
    expect(isSubscriptionOrder(["sale", "vip"])).toBe(false);
  });

  it("returns false for empty/null/non-array", () => {
    expect(isSubscriptionOrder([])).toBe(false);
    expect(isSubscriptionOrder(null)).toBe(false);
    expect(isSubscriptionOrder(undefined)).toBe(false);
    expect(isSubscriptionOrder("recurring-order")).toBe(false);
  });
});

// ─── Order classification ─────────────────────────────────────────────

describe("classifyOrder: tier and frequency detection", () => {
  it("classifies $5 as Color Happy monthly", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 500));
    expect(result.tier).toBe("color-happy");
    expect(result.frequency).toBe("monthly");
    expect(result.monthsCovered).toBe(1);
    expect(result.monthlyValueCents).toBe(500);
  });

  it("classifies $55 as Color Happy yearly (12 months)", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 5500));
    expect(result.tier).toBe("color-happy");
    expect(result.frequency).toBe("yearly");
    expect(result.monthsCovered).toBe(12);
    expect(result.monthlyValueCents).toBe(458); // 5500/12 rounded
  });

  it("classifies $8 as RAD Tier 1 monthly", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 800));
    expect(result.tier).toBe("rad-tier-1");
    expect(result.frequency).toBe("monthly");
    expect(result.monthsCovered).toBe(1);
  });

  it("classifies $72 as RAD Tier 1 yearly (12 months)", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 7200));
    expect(result.tier).toBe("rad-tier-1");
    expect(result.frequency).toBe("yearly");
    expect(result.monthsCovered).toBe(12);
    expect(result.monthlyValueCents).toBe(600);
  });

  it("classifies $15 as RAD Tier 2 monthly", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 1500));
    expect(result.tier).toBe("rad-tier-2");
    expect(result.frequency).toBe("monthly");
  });

  it("classifies $144 as RAD Tier 2 yearly (12 months)", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 14400));
    expect(result.tier).toBe("rad-tier-2");
    expect(result.frequency).toBe("yearly");
    expect(result.monthsCovered).toBe(12);
  });

  it("classifies unknown price as unknown", () => {
    const result = classifyOrder(makeOrder("c1", "2025-01-01", 9999));
    expect(result.tier).toBe("unknown");
    expect(result.frequency).toBe("unknown");
  });
});

// ─── Customer LTV ─────────────────────────────────────────────────────

describe("computeCustomerLtv", () => {
  it("computes LTV for monthly subscriber with 6 orders", () => {
    const orders = [
      makeOrder("c1", "2025-01-15", 800),
      makeOrder("c1", "2025-02-15", 800),
      makeOrder("c1", "2025-03-15", 800),
      makeOrder("c1", "2025-04-15", 800),
      makeOrder("c1", "2025-05-15", 800),
      makeOrder("c1", "2025-06-15", 800),
    ];
    const ltv = computeCustomerLtv(orders, "c1", AS_OF);
    expect(ltv).not.toBeNull();
    expect(ltv!.totalOrders).toBe(6);
    expect(ltv!.totalRevenueCents).toBe(4800);
    expect(ltv!.totalMonthsCovered).toBe(6);
    expect(ltv!.avgMonthlyRevenueCents).toBe(800);
    expect(ltv!.currentTier).toBe("rad-tier-1");
    expect(ltv!.currentFrequency).toBe("monthly");
  });

  it("computes LTV for yearly subscriber correctly", () => {
    const orders = [makeOrder("c1", "2025-01-01", 7200)];
    const ltv = computeCustomerLtv(orders, "c1", AS_OF);
    expect(ltv!.totalMonthsCovered).toBe(12);
    expect(ltv!.avgMonthlyRevenueCents).toBe(600);
    expect(ltv!.currentFrequency).toBe("yearly");
  });

  it("computes LTV for customer who migrated CH to RAD", () => {
    const orders = [
      makeOrder("c1", "2024-06-01", 500),
      makeOrder("c1", "2024-07-01", 500),
      makeOrder("c1", "2024-08-01", 500),
      makeOrder("c1", "2024-09-01", 800),
      makeOrder("c1", "2024-10-01", 800),
      makeOrder("c1", "2024-11-01", 800),
    ];
    const ltv = computeCustomerLtv(orders, "c1", AS_OF);
    expect(ltv!.totalOrders).toBe(6);
    expect(ltv!.totalRevenueCents).toBe(3900);
    expect(ltv!.totalMonthsCovered).toBe(6);
    expect(ltv!.currentTier).toBe("rad-tier-1");
  });

  it("uses longer churn threshold for yearly subscribers", () => {
    const orders = [makeOrder("c1", "2024-12-01", 7200)];
    const ltv = computeCustomerLtv(orders, "c1", AS_OF);
    expect(ltv!.isChurned).toBe(false); // ~7 months < 13 month threshold
  });

  it("marks yearly subscriber as churned after 13 months", () => {
    const orders = [makeOrder("c1", "2024-05-01", 7200)];
    const ltv = computeCustomerLtv(orders, "c1", AS_OF);
    expect(ltv!.isChurned).toBe(true);
  });

  it("returns null for empty orders", () => {
    expect(computeCustomerLtv([], "c1", AS_OF)).toBeNull();
  });

  it("filters to the specified customer", () => {
    const orders = [
      makeOrder("c1", "2025-01-01", 800),
      makeOrder("c2", "2025-01-01", 800),
    ];
    const ltv = computeCustomerLtv(orders, "c1", AS_OF);
    expect(ltv!.totalOrders).toBe(1);
  });
});

// ─── LTV Summary ──────────────────────────────────────────────────────

describe("computeLtvSummary", () => {
  it("computes summary with tier breakdown", () => {
    const orders = [
      makeOrder("c1", "2025-01-15", 800),
      makeOrder("c1", "2025-02-15", 800),
      makeOrder("c1", "2025-03-15", 800),
      makeOrder("c1", "2025-04-15", 800),
      makeOrder("c1", "2025-05-15", 800),
      makeOrder("c1", "2025-06-15", 800),
      makeOrder("c2", "2025-01-01", 7200),
      makeOrder("c3", "2024-06-01", 500),
      makeOrder("c3", "2024-07-01", 500),
      makeOrder("c3", "2024-08-01", 500),
    ];

    const summary = computeLtvSummary(orders, AS_OF);
    expect(summary.totalSubscribers).toBe(3);
    expect(summary.tiers.length).toBeGreaterThan(0);

    const radTier1 = summary.tiers.find((t) => t.tier === "rad-tier-1");
    expect(radTier1).toBeDefined();
    expect(radTier1!.subscribers).toBe(2);

    const chTier = summary.tiers.find((t) => t.tier === "color-happy");
    expect(chTier).toBeDefined();
    expect(chTier!.churned).toBe(1);
  });

  it("handles empty order list", () => {
    const summary = computeLtvSummary([], AS_OF);
    expect(summary.totalSubscribers).toBe(0);
    expect(summary.tiers).toHaveLength(0);
  });
});
