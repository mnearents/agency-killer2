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
    firstSubscriptionOrderAt: new Date("2025-08-01T00:00:00Z"),
    lastSubscriptionOrderAt: new Date("2026-02-01T00:00:00Z"),
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

  it("carries the subscription-order proxy dates through", () => {
    const r = deriveCustomerFields({ orders: agg(), subscriptions: [] }, DERIVED_AT);
    expect(r.firstSubscriptionOrderAt).toEqual(new Date("2025-08-01T00:00:00Z"));
    expect(r.lastSubscriptionOrderAt).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  // 85.7% of the lapsed have no subscription order in our history — it begins
  // 2025-07-22 and they churned before it. Null is the answer, and a zero or a
  // fallback to first_order_at would put 13,174 people into a tenure band
  // computed from a date that has nothing to do with their subscription.
  it("leaves the proxy dates null when the customer bought no subscription product", () => {
    const r = deriveCustomerFields(
      {
        orders: agg({ firstSubscriptionOrderAt: null, lastSubscriptionOrderAt: null }),
        subscriptions: [],
      },
      DERIVED_AT
    );
    expect(r.firstSubscriptionOrderAt).toBeNull();
    expect(r.lastSubscriptionOrderAt).toBeNull();
    // The ordinary order dates are still known — the absence is specific.
    expect(r.firstOrderAt).toEqual(new Date("2025-04-01T00:00:00Z"));
  });

  it("leaves the proxy dates null for a customer with no orders at all", () => {
    const r = deriveCustomerFields({ orders: null, subscriptions: [] }, DERIVED_AT);
    expect(r.firstSubscriptionOrderAt).toBeNull();
    expect(r.lastSubscriptionOrderAt).toBeNull();
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
  const { sql, params } = buildCustomerOrderAggregateQuery(db).toSQL();

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

  // Subscription dates did not survive two app migrations, so first and last
  // subscription order are the only signup and cancellation proxies we have.
  // They are scoped by product_type = 'Subscription' rather than by title:
  // "Color Happy" and the three "Really Awesome Doodles" variants all carry it,
  // and a title pattern would have to be maintained against the catalogue.
  it("derives the subscription-order proxy dates from the Subscription product type", () => {
    expect(sql).toContain("first_subscription_order_at");
    expect(sql).toContain("last_subscription_order_at");
    // Bound, not inlined — so it is asserted where it actually appears.
    expect(params).toContain("Subscription");
  });

  // is_recurring is set from the order; the proxy dates must come from what was
  // bought. Color Happy sold 36,604 line items of which only 15,518 sat on a
  // recurring order — the rest are gifts and one-offs of the same product, and
  // scoping on is_recurring would silently change which population this is.
  it("scopes the proxy dates on the product bought, not on is_recurring", () => {
    // Read the FILTER clauses themselves. Searching the whole statement would
    // find product_type in the unrelated product-types subquery and pass no
    // matter what these two are scoped on.
    const filters = sql.match(/filter \(where[\s\S]*?\)\s*\)/gi) ?? [];
    expect(filters).toHaveLength(2);
    for (const f of filters) {
      expect(f).toContain("li.product_type");
      expect(f).not.toContain("is_recurring");
    }
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
