import { describe, it, expect } from "vitest";
import { isSubscriptionOrder } from "@/domain/shopify/subscription-tags";

describe("isSubscriptionOrder: tag detection", () => {
  it("recognises a recurring-order tag", () => {
    expect(isSubscriptionOrder(["recurring-order"])).toBe(true);
  });

  it("recognises the legacy Color Happy first-order tag", () => {
    expect(isSubscriptionOrder(["colorhappy-first"])).toBe(true);
  });

  it("recognises the RAD first-order tag", () => {
    expect(isSubscriptionOrder(["rad-first"])).toBe(true);
  });

  it("rejects unrelated tags", () => {
    expect(isSubscriptionOrder(["sale", "vip"])).toBe(false);
  });

  it("rejects empty and non-array input rather than throwing", () => {
    expect(isSubscriptionOrder([])).toBe(false);
    expect(isSubscriptionOrder(null)).toBe(false);
    expect(isSubscriptionOrder(undefined)).toBe(false);
    // A bare string happens to contain the tag; it is still not a tag list.
    expect(isSubscriptionOrder("recurring-order")).toBe(false);
  });
});
