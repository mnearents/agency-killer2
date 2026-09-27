import { describe, it, expect } from "vitest";
import {
  isOwnedVendor, splitByOwnership, OWNED_VENDORS, KNOWN_EXTERNAL_VENDORS,
} from "@/domain/inventory/ownership";

describe("isOwnedVendor", () => {
  it("owns Rad & Happy stock", () => {
    expect(isOwnedVendor("Rad & Happy")).toBe(true);
  });

  // The coloring ties sell here but sit on Boon Ties' shelf.
  it("does not own drop-shipped stock", () => {
    expect(isOwnedVendor("Boon Ties")).toBe(false);
  });

  it("does not own app-created products", () => {
    for (const v of ["re:do", "Route", "Printify"]) {
      expect(isOwnedVendor(v), v).toBe(false);
    }
  });

  // Vendor is free text in Shopify.
  it("tolerates case and surrounding space", () => {
    expect(isOwnedVendor("  rad & happy ")).toBe(true);
    expect(isOwnedVendor("RAD & HAPPY")).toBe(true);
  });

  // All 283 own-brand products carry the vendor, so a blank is a data gap on
  // something almost certainly ours. Excluding it would quietly drop real
  // inventory, which is worse than including one drop-shipped item.
  it("treats a missing vendor as ours rather than dropping it", () => {
    expect(isOwnedVendor(null)).toBe(true);
    expect(isOwnedVendor("")).toBe(true);
    expect(isOwnedVendor("   ")).toBe(true);
    expect(isOwnedVendor(undefined)).toBe(true);
  });

  // Declared, not inferred: a rule like "anything but Printify" would admit
  // the next drop-shipper someone adds.
  it("declares the owned and known-external vendors", () => {
    expect(OWNED_VENDORS).toEqual(["Rad & Happy"]);
    expect(KNOWN_EXTERNAL_VENDORS).toContain("Boon Ties");
  });
});

describe("splitByOwnership", () => {
  const items = [
    { sku: "PLN-1", vendor: "Rad & Happy" },
    { sku: "TIE-1", vendor: "Boon Ties" },
    { sku: "TIE-2", vendor: "Boon Ties" },
    { sku: "PLN-2", vendor: null },
  ];
  const split = () => splitByOwnership(items, (i) => i.vendor);

  it("keeps ours and sets aside theirs", () => {
    expect(split().owned.map((i) => i.sku)).toEqual(["PLN-1", "PLN-2"]);
    expect(split().external.map((i) => i.sku)).toEqual(["TIE-1", "TIE-2"]);
  });

  // An exclusion nobody can see is how a number quietly changes meaning.
  it("reports what was set aside, and by whom", () => {
    expect(split().excludedByVendor).toEqual({ "Boon Ties": 2 });
  });

  it("reports nothing excluded when everything is ours", () => {
    const s = splitByOwnership([{ vendor: "Rad & Happy" }], (i) => i.vendor);
    expect(s.external).toEqual([]);
    expect(s.excludedByVendor).toEqual({});
  });

  it("handles an empty list without inventing a vendor", () => {
    expect(splitByOwnership([], () => null)).toEqual({
      owned: [], external: [], excludedByVendor: {},
    });
  });
});

import { classifyItem, type InventoryItem } from "@/domain/inventory/checks";

const item = (over: Partial<InventoryItem> = {}): InventoryItem => ({
  variantId: "v1", productTitle: "Rad Dad Coloring Tie", variantTitle: "M",
  sku: "D-M", quantity: 418, tracked: true, productStatus: "ACTIVE",
  vendor: "Rad & Happy", unitsSoldLast30d: 0, ...over,
});

describe("classifyItem and drop-shipped stock", () => {
  // 2,100 units of ties read as tracked stock — about $54,000 at retail that
  // is not ours, which distorts both stock on hand and capital tied up.
  it("classifies drop-shipped stock as not ours", () => {
    expect(classifyItem(item({ vendor: "Boon Ties" }))).toBe("not-our-stock");
  });

  // Its own class rather than `ignored`: those are excluded for being
  // unreadable or unsellable, this one for not being ours, and collapsing them
  // hides why a SKU vanished from a count.
  it("keeps it distinct from ignored", () => {
    expect(classifyItem(item({ vendor: "Boon Ties" }))).not.toBe("ignored");
    expect(classifyItem(item({ tracked: false }))).toBe("ignored");
  });

  // Ownership is checked before anything else: stock level, cover and COGS of
  // a drop-shipped item all describe someone else's business.
  it("wins over every other classification", () => {
    expect(classifyItem(item({ vendor: "Boon Ties", quantity: 0, unitsSoldLast30d: 9 })))
      .toBe("not-our-stock");
    expect(classifyItem(item({ vendor: "Boon Ties", quantity: 9999, unitsSoldLast30d: 0 })))
      .toBe("not-our-stock");
  });

  it("still classifies our own stock normally", () => {
    expect(classifyItem(item({ quantity: 0, unitsSoldLast30d: 9 }))).toBe("stockout");
    expect(classifyItem(item({ quantity: 9999, unitsSoldLast30d: 0 }))).toBe("slow-mover");
  });

  it("treats a variant with no vendor as ours", () => {
    expect(classifyItem(item({ vendor: null, quantity: 0, unitsSoldLast30d: 9 }))).toBe("stockout");
  });
});
