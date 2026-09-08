import { describe, it, expect } from "vitest";
import { transformCustomer } from "@/domain/shopify/customer-transform";
import type { ShopifyApiCustomerProfile } from "@/integrations/shopify-api";

const SYNCED_AT = new Date("2026-09-07T12:00:00Z");

const BASE: ShopifyApiCustomerProfile = {
  id: "gid://shopify/Customer/456",
  email: "tara@example.com",
  firstName: "Tara",
  lastName: "H",
  createdAt: "2025-03-01T09:00:00Z",
  numberOfOrders: "7",
  amountSpent: { amount: "184.50" },
  tags: ["teacher", "vip"],
  emailMarketingConsent: { marketingState: "SUBSCRIBED" },
  defaultAddress: { city: "Boise", province: "Idaho", country: "United States" },
};

describe("transformCustomer", () => {
  it("keeps the GID form of the customer id", () => {
    // shopify_orders.customer_id is a GID too, so the order join is direct.
    // The Seal join extracts the numeric part instead — see queries.
    expect(transformCustomer(BASE, SYNCED_AT).id).toBe("gid://shopify/Customer/456");
  });

  it("converts amount spent from dollars to cents", () => {
    expect(transformCustomer(BASE, SYNCED_AT).totalSpentCents).toBe(18450);
  });

  it("parses the order count Shopify sends as a string", () => {
    expect(transformCustomer(BASE, SYNCED_AT).ordersCount).toBe(7);
  });

  it("maps geography from the default address", () => {
    const r = transformCustomer(BASE, SYNCED_AT);
    expect(r.city).toBe("Boise");
    expect(r.state).toBe("Idaho");
    expect(r.country).toBe("United States");
  });

  it("leaves geography null when there is no default address", () => {
    const r = transformCustomer({ ...BASE, defaultAddress: null }, SYNCED_AT);
    expect(r.city).toBeNull();
    expect(r.state).toBeNull();
    expect(r.country).toBeNull();
  });

  it("stores acceptsMarketing as 1 when subscribed", () => {
    expect(transformCustomer(BASE, SYNCED_AT).acceptsMarketing).toBe(1);
  });

  it("stores acceptsMarketing as 0 when not subscribed", () => {
    const r = transformCustomer(
      { ...BASE, emailMarketingConsent: { marketingState: "UNSUBSCRIBED" } },
      SYNCED_AT
    );
    expect(r.acceptsMarketing).toBe(0);
  });

  // "No consent record" is not "declined consent". Collapsing it to 0 would
  // silently shrink every marketable audience by an unknown amount.
  it("leaves acceptsMarketing null when Shopify has no consent record", () => {
    const r = transformCustomer({ ...BASE, emailMarketingConsent: null }, SYNCED_AT);
    expect(r.acceptsMarketing).toBeNull();
  });

  // Named customerTags, not tags. shopify_orders.tags holds the *product's*
  // tags copied onto the order and is contaminated; customer tags carry
  // subscription lifecycle state and are authoritative. Two columns both called
  // `tags` is what made one get queried in place of the other.
  it("maps customer tags to a field named apart from order tags", () => {
    const r = transformCustomer(BASE, SYNCED_AT);
    expect(r.customerTags).toEqual(["teacher", "vip"]);
    expect(r).not.toHaveProperty("tags");
  });

  it("maps the customer creation date", () => {
    const r = transformCustomer(BASE, SYNCED_AT);
    expect(r.customerCreatedAt).toEqual(new Date("2025-03-01T09:00:00Z"));
  });

  // A customer with no tags has an empty list; null would mean "we never
  // fetched them", and the lapsed segment is defined by tag absence.
  it("distinguishes no tags from tags not fetched", () => {
    expect(transformCustomer({ ...BASE, tags: [] }, SYNCED_AT).customerTags).toEqual([]);
  });

  it("carries PII through to the base table", () => {
    // Stored here, excluded by the analytics view rather than at this layer.
    const r = transformCustomer(BASE, SYNCED_AT);
    expect(r.email).toBe("tara@example.com");
    expect(r.firstName).toBe("Tara");
  });

  // Shopify omits amountSpent for customers who have never ordered.
  it("leaves total spent null rather than zero when Shopify omits it", () => {
    const r = transformCustomer({ ...BASE, amountSpent: null }, SYNCED_AT);
    expect(r.totalSpentCents).toBeNull();
  });

  it("does not populate derived fields — the rollup owns those", () => {
    const r = transformCustomer(BASE, SYNCED_AT);
    expect(r.lifetimeOrders).toBeUndefined();
    expect(r.isSubscriber).toBeUndefined();
    expect(r.derivedAt).toBeUndefined();
  });

  it("sets syncedAt", () => {
    expect(transformCustomer(BASE, SYNCED_AT).syncedAt).toEqual(SYNCED_AT);
  });
});
