import { describe, it, expect } from "vitest";
import {
  transformOrder,
  transformLineItem,
  transformOrderWithLineItems,
} from "@/domain/shopify/sync-transform";
import type { ShopifyApiOrder, ShopifyApiLineItem } from "@/integrations/shopify-api";

const SYNCED_AT = new Date("2025-06-15T12:00:00Z");

const BASE_ORDER: ShopifyApiOrder = {
  id: "gid://shopify/Order/123",
  name: "#1001",
  createdAt: "2025-06-10T14:30:00Z",
  currencyCode: "USD",
  totalPriceSet: { shopMoney: { amount: "29.99" } },
  subtotalPriceSet: { shopMoney: { amount: "24.99" } },
  totalTaxSet: { shopMoney: { amount: "2.50" } },
  totalDiscountsSet: { shopMoney: { amount: "5.00" } },
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "FULFILLED",
  customer: { id: "gid://shopify/Customer/456" },
  tags: ["wholesale", "vip"],
  discountCodes: ["SUMMER10"],
  sourceIdentifier: "web",
  referringSite: "https://google.com",
  landingSite: null,
  lineItems: { nodes: [] },
};

const BASE_LINE_ITEM: ShopifyApiLineItem = {
  id: "gid://shopify/LineItem/789",
  title: "Daily Planner - Rose Gold",
  quantity: 2,
  originalUnitPriceSet: { shopMoney: { amount: "14.99" } },
  product: { id: "gid://shopify/Product/111", productType: "Planner" },
  variant: { id: "gid://shopify/ProductVariant/222", sku: "PLN-RG-001" },
};

// ─── Order transforms ─────────────────────────────────────────────────

describe("transformOrder: money conversion", () => {
  it("converts totalPrice from dollars to cents", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    // "29.99" → 2999 cents
    expect(result.totalPriceCents).toBe(2999);
  });

  it("converts subtotal, tax, and discounts to cents", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.subtotalPriceCents).toBe(2499);
    expect(result.totalTaxCents).toBe(250);
    expect(result.totalDiscountsCents).toBe(500);
  });

  it("handles zero amounts", () => {
    const order = {
      ...BASE_ORDER,
      totalDiscountsSet: { shopMoney: { amount: "0.00" } },
    };
    const result = transformOrder(order, SYNCED_AT);
    expect(result.totalDiscountsCents).toBe(0);
  });
});

describe("transformOrder: field mapping", () => {
  it("maps order ID and number", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.id).toBe("gid://shopify/Order/123");
    expect(result.orderNumber).toBe("#1001");
  });

  it("maps customer ID", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.customerId).toBe("gid://shopify/Customer/456");
  });

  it("handles null customer", () => {
    const order = { ...BASE_ORDER, customer: null };
    const result = transformOrder(order, SYNCED_AT);
    expect(result.customerId).toBeNull();
  });

  it("maps order creation date", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.orderCreatedAt).toEqual(new Date("2025-06-10T14:30:00Z"));
  });

  it("stores tags and discount codes as JSON", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.tags).toEqual(["wholesale", "vip"]);
    expect(result.discountCodes).toEqual(["SUMMER10"]);
  });

  it("stores raw JSON for audit trail", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.rawJson).toEqual(BASE_ORDER);
  });

  it("sets syncedAt", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.syncedAt).toEqual(SYNCED_AT);
  });
});

describe("transformOrder: subscription detection", () => {
  it("sets isRecurring=1 when tags contain 'recurring-order'", () => {
    const order = {
      ...BASE_ORDER,
      tags: ["recurring-order", "subscription"],
    };
    const result = transformOrder(order, SYNCED_AT);
    expect(result.isRecurring).toBe(1);
  });

  it("sets isRecurring=0 when tags do not contain 'recurring-order'", () => {
    const result = transformOrder(BASE_ORDER, SYNCED_AT);
    expect(result.isRecurring).toBe(0);
  });

  it("sets isRecurring=0 when tags are empty", () => {
    const order = { ...BASE_ORDER, tags: [] };
    const result = transformOrder(order, SYNCED_AT);
    expect(result.isRecurring).toBe(0);
  });
});

// ─── Line item transforms ─────────────────────────────────────────────

describe("transformLineItem", () => {
  it("converts unit price from dollars to cents", () => {
    const result = transformLineItem(BASE_LINE_ITEM, "order_123");
    // "14.99" → 1499 cents
    expect(result.priceCents).toBe(1499);
  });

  it("maps product and variant IDs", () => {
    const result = transformLineItem(BASE_LINE_ITEM, "order_123");
    expect(result.productId).toBe("gid://shopify/Product/111");
    expect(result.variantId).toBe("gid://shopify/ProductVariant/222");
    expect(result.sku).toBe("PLN-RG-001");
    expect(result.productType).toBe("Planner");
  });

  it("handles null product and variant", () => {
    const item = { ...BASE_LINE_ITEM, product: null, variant: null };
    const result = transformLineItem(item, "order_123");
    expect(result.productId).toBeNull();
    expect(result.variantId).toBeNull();
    expect(result.sku).toBeNull();
    expect(result.productType).toBeNull();
  });

  it("maps quantity and title", () => {
    const result = transformLineItem(BASE_LINE_ITEM, "order_123");
    expect(result.quantity).toBe(2);
    expect(result.title).toBe("Daily Planner - Rose Gold");
  });

  it("sets orderId from parameter", () => {
    const result = transformLineItem(BASE_LINE_ITEM, "order_123");
    expect(result.orderId).toBe("order_123");
  });
});

// ─── Combined transform ──────────────────────────────────────────────

describe("transformOrderWithLineItems", () => {
  it("returns order and line items together", () => {
    const order: ShopifyApiOrder = {
      ...BASE_ORDER,
      lineItems: { nodes: [BASE_LINE_ITEM] },
    };
    const result = transformOrderWithLineItems(order, SYNCED_AT);
    expect(result.order.id).toBe("gid://shopify/Order/123");
    expect(result.lineItems).toHaveLength(1);
    expect(result.lineItems[0].title).toBe("Daily Planner - Rose Gold");
  });

  it("passes order ID to each line item", () => {
    const order: ShopifyApiOrder = {
      ...BASE_ORDER,
      lineItems: { nodes: [BASE_LINE_ITEM] },
    };
    const result = transformOrderWithLineItems(order, SYNCED_AT);
    expect(result.lineItems[0].orderId).toBe("gid://shopify/Order/123");
  });
});
