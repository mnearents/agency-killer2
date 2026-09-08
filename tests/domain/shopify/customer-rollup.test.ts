import { describe, it, expect } from "vitest";
import { createDb } from "@/db/client";
import {
  deriveCustomerFields,
  buildCustomerOrderAggregateQuery,
  buildCustomerSubscriptionQuery,
  type CustomerOrderAggregate,
  type CustomerSubscription,
} from "@/domain/shopify/customer-rollup";

const DERIVED_AT = new Date("2026-09-07T12:00:00Z");

function agg(over: Partial<CustomerOrderAggregate> = {}): CustomerOrderAggregate {
  return {
    customerId: "gid://shopify/Customer/456",
    firstOrderAt: new Date("2025-04-01T00:00:00Z"),
    lastOrderAt: new Date("2026-08-01T00:00:00Z"),
    lifetimeOrders: 4,
    subscriptionRevenueCents: 12000,
    oneOffRevenueCents: 3400,
    productTypes: ["Planner", "Sticker"],
    ...over,
  };
}

function sub(over: Partial<CustomerSubscription> = {}): CustomerSubscription {
  return {
    status: "ACTIVE",
    tier: "spark",
    orderPlaced: new Date("2025-06-01T00:00:00Z"),
    manualOrigin: false,
    ...over,
  };
}

describe("deriveCustomerFields — orders", () => {
  it("carries the order aggregate through", () => {
    const r = deriveCustomerFields({ orders: agg(), subscriptions: [] }, DERIVED_AT);
    expect(r.lifetimeOrders).toBe(4);
    expect(r.firstOrderAt).toEqual(new Date("2025-04-01T00:00:00Z"));
    expect(r.lastOrderAt).toEqual(new Date("2026-08-01T00:00:00Z"));
    expect(r.subscriptionRevenueCents).toBe(12000);
    expect(r.oneOffRevenueCents).toBe(3400);
    expect(r.productTypesPurchased).toEqual(["Planner", "Sticker"]);
  });

  // Zero here means "the rollup looked and found none", which is only readable
  // as such because derivedAt is set alongside it. Null would mean never ran.
  it("reports zero, not null, for a customer with no orders", () => {
    const r = deriveCustomerFields({ orders: null, subscriptions: [] }, DERIVED_AT);
    expect(r.lifetimeOrders).toBe(0);
    expect(r.subscriptionRevenueCents).toBe(0);
    expect(r.oneOffRevenueCents).toBe(0);
    expect(r.productTypesPurchased).toEqual([]);
    expect(r.firstOrderAt).toBeNull();
    expect(r.lastOrderAt).toBeNull();
    expect(r.derivedAt).toEqual(DERIVED_AT);
  });

  it("always stamps derivedAt", () => {
    const r = deriveCustomerFields({ orders: agg(), subscriptions: [] }, DERIVED_AT);
    expect(r.derivedAt).toEqual(DERIVED_AT);
  });

  // days_since_last_order is deliberately not stored — it would be wrong the
  // moment a day passed. The view computes it from last_order_at.
  it("does not store a days-since-last-order number", () => {
    const r = deriveCustomerFields({ orders: agg(), subscriptions: [] }, DERIVED_AT);
    expect(r).not.toHaveProperty("daysSinceLastOrder");
  });
});

describe("deriveCustomerFields — subscriptions", () => {
  it("marks a customer with an active subscription as a subscriber", () => {
    const r = deriveCustomerFields({ orders: agg(), subscriptions: [sub()] }, DERIVED_AT);
    expect(r.isSubscriber).toBe(1);
    expect(r.subscriptionStatus).toBe("ACTIVE");
    expect(r.subscriptionTier).toBe("spark");
  });

  it("marks a customer whose only subscription is cancelled as not a subscriber", () => {
    const r = deriveCustomerFields(
      { orders: agg(), subscriptions: [sub({ status: "CANCELLED", tier: "studio" })] },
      DERIVED_AT
    );
    expect(r.isSubscriber).toBe(0);
    expect(r.subscriptionStatus).toBe("CANCELLED");
    expect(r.subscriptionTier).toBe("studio");
  });

  // A lapsed-then-resubscribed customer is a subscriber. Taking the most recent
  // row regardless of status would call them lapsed whenever the cancellation
  // happened to be recorded later.
  it("prefers the active subscription over a cancelled one", () => {
    const r = deriveCustomerFields(
      {
        orders: agg(),
        subscriptions: [
          sub({ status: "CANCELLED", tier: "spark", orderPlaced: new Date("2026-01-01T00:00:00Z") }),
          sub({ status: "ACTIVE", tier: "studio", orderPlaced: new Date("2025-06-01T00:00:00Z") }),
        ],
      },
      DERIVED_AT
    );
    expect(r.isSubscriber).toBe(1);
    expect(r.subscriptionTier).toBe("studio");
  });

  it("takes the most recent among subscriptions of the same status", () => {
    const r = deriveCustomerFields(
      {
        orders: agg(),
        subscriptions: [
          sub({ status: "CANCELLED", tier: "spark", orderPlaced: new Date("2025-02-01T00:00:00Z") }),
          sub({ status: "CANCELLED", tier: "studio", orderPlaced: new Date("2026-02-01T00:00:00Z") }),
        ],
      },
      DERIVED_AT
    );
    expect(r.subscriptionTier).toBe("studio");
  });

  // manual_origin rows carry the bulk-import timestamp as order_placed (the
  // ~329 Color Happy rows all dated June 2026), so ordering by that date puts
  // them ahead of every real subscription. Rank real rows first.
  it("does not let a bulk-imported row outrank a real one on its import date", () => {
    const r = deriveCustomerFields(
      {
        orders: agg(),
        subscriptions: [
          sub({
            status: "CANCELLED",
            tier: "spark",
            manualOrigin: true,
            orderPlaced: new Date("2026-06-03T00:00:00Z"),
          }),
          sub({
            status: "CANCELLED",
            tier: "studio",
            manualOrigin: false,
            orderPlaced: new Date("2025-09-01T00:00:00Z"),
          }),
        ],
      },
      DERIVED_AT
    );
    expect(r.subscriptionTier).toBe("studio");
  });

  it("still uses a manual row when it is the only one", () => {
    const r = deriveCustomerFields(
      { orders: agg(), subscriptions: [sub({ manualOrigin: true, tier: "studio" })] },
      DERIVED_AT
    );
    expect(r.isSubscriber).toBe(1);
    expect(r.subscriptionTier).toBe("studio");
  });

  it("reports a non-subscriber as 0 with no tier rather than null", () => {
    const r = deriveCustomerFields({ orders: agg(), subscriptions: [] }, DERIVED_AT);
    expect(r.isSubscriber).toBe(0);
    expect(r.subscriptionTier).toBeNull();
    expect(r.subscriptionStatus).toBeNull();
  });

  // "unknown" is a real Seal classification, not a missing value. Collapsing it
  // to null would hide subscriptions whose variant we failed to map.
  it("keeps an unknown tier as unknown", () => {
    const r = deriveCustomerFields(
      { orders: agg(), subscriptions: [sub({ tier: "unknown" })] },
      DERIVED_AT
    );
    expect(r.subscriptionTier).toBe("unknown");
  });

  it("ranks a subscription with no order date below one that has a date", () => {
    const r = deriveCustomerFields(
      {
        orders: agg(),
        subscriptions: [
          sub({ status: "CANCELLED", tier: "spark", orderPlaced: null }),
          sub({
            status: "CANCELLED",
            tier: "studio",
            orderPlaced: new Date("2024-01-01T00:00:00Z"),
          }),
        ],
      },
      DERIVED_AT
    );
    expect(r.subscriptionTier).toBe("studio");
  });
});

// postgres-js connects lazily, so this never opens a socket — we only inspect
// the SQL the query builder generates.
const db = createDb("postgres://user:pass@localhost:5432/test");

describe("buildCustomerOrderAggregateQuery", () => {
  const { sql } = buildCustomerOrderAggregateQuery(db).toSQL();

  // One lifetime_revenue number averages a $25.79 one-off buyer and a
  // $60-180/yr subscriber into something that describes neither.
  it("splits revenue on is_recurring rather than totalling it", () => {
    expect(sql).toContain("is_recurring");
    expect(sql).toMatch(/subscription_revenue_cents/);
    expect(sql).toMatch(/one_off_revenue_cents/);
  });

  it("groups by the order's customer id", () => {
    expect(sql).toContain("customer_id");
    expect(sql).toMatch(/group by/i);
  });

  it("collects distinct product types from line items", () => {
    expect(sql).toMatch(/distinct/i);
    expect(sql).toContain("product_type");
  });

  // A customer whose only orders predate line-item capture still has orders.
  // An inner join would drop them from the rollup entirely.
  it("does not drop customers whose orders have no line items", () => {
    expect(sql).toMatch(/left join/i);
    expect(sql).not.toMatch(/inner join\s+"shopify_line_items"/i);
  });
});

describe("buildCustomerSubscriptionQuery", () => {
  const { sql } = buildCustomerSubscriptionQuery(db).toSQL();

  // Seal stores the bare numeric customer ID; Shopify stores a GID. The join
  // only lands if one side is reduced to the other's form.
  it("joins Seal to Shopify by extracting the numeric part of the GID", () => {
    expect(sql).toContain("split_part");
  });

  it("selects the fields the ranking depends on", () => {
    expect(sql).toContain("status");
    expect(sql).toContain("tier");
    expect(sql).toContain("order_placed");
    expect(sql).toContain("manual_origin");
  });
});
