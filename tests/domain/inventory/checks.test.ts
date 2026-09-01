import { describe, it, expect } from "vitest";
import {
  classifyItem,
  runInventoryChecks,
  type InventoryItem,
} from "@/domain/inventory/checks";

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    variantId: "gid://shopify/ProductVariant/1",
    productTitle: "Really Awesome Doodles",
    variantTitle: "Default",
    sku: "RAD-001",
    quantity: 100,
    tracked: true,
    productStatus: "ACTIVE",
    unitsSoldLast30d: 30,
    ...overrides,
  };
}

describe("classifyItem", () => {
  it("ignores variants Shopify does not track — their quantity is always 0", () => {
    expect(classifyItem(item({ tracked: false, quantity: 0 }))).toBe("ignored");
  });

  it("ignores archived products", () => {
    expect(classifyItem(item({ productStatus: "ARCHIVED", quantity: 0 }))).toBe("ignored");
  });

  it("ignores draft products", () => {
    expect(classifyItem(item({ productStatus: "DRAFT", quantity: 0 }))).toBe("ignored");
  });

  it("flags a stockout when an actively selling variant hits zero", () => {
    expect(classifyItem(item({ quantity: 0, unitsSoldLast30d: 30 }))).toBe("stockout");
  });

  it("flags a stockout when oversold into negative quantity", () => {
    expect(classifyItem(item({ quantity: -3, unitsSoldLast30d: 30 }))).toBe("stockout");
  });

  it("does not flag a stockout for a variant that never sells", () => {
    expect(classifyItem(item({ quantity: 0, unitsSoldLast30d: 0 }))).not.toBe("stockout");
  });

  it("flags low cover when stock runs out inside the reorder lead time", () => {
    // 30 sold in 30d = 1/day, 10 on hand = 10 days cover, lead time 14
    expect(classifyItem(item({ quantity: 10, unitsSoldLast30d: 30 }))).toBe("low-cover");
  });

  it("does not flag low cover when stock outlasts the reorder lead time", () => {
    // 1/day, 60 on hand = 60 days cover
    expect(classifyItem(item({ quantity: 60, unitsSoldLast30d: 30 }))).toBe("healthy");
  });

  it("respects a custom reorder lead time", () => {
    // 1/day, 20 on hand = 20 days cover — healthy at 14, low at 30
    expect(classifyItem(item({ quantity: 20, unitsSoldLast30d: 30 }))).toBe("healthy");
    expect(
      classifyItem(item({ quantity: 20, unitsSoldLast30d: 30 }), { reorderLeadTimeDays: 30 })
    ).toBe("low-cover");
  });

  it("flags a slow mover when stock is deep and nothing is selling", () => {
    expect(classifyItem(item({ quantity: 200, unitsSoldLast30d: 0 }))).toBe("slow-mover");
  });

  it("does not flag a slow mover when the leftover quantity is trivial", () => {
    expect(classifyItem(item({ quantity: 3, unitsSoldLast30d: 0 }))).toBe("healthy");
  });
});

describe("runInventoryChecks", () => {
  it("returns no alerts when everything is healthy", () => {
    expect(runInventoryChecks([item(), item({ variantId: "2" })])).toEqual([]);
  });

  it("rolls all stockouts into a single urgent alert rather than one per SKU", () => {
    const alerts = runInventoryChecks([
      item({ variantId: "1", productTitle: "Doodle Pad", quantity: 0, unitsSoldLast30d: 30 }),
      item({ variantId: "2", productTitle: "Sticker Set", quantity: 0, unitsSoldLast30d: 60 }),
    ]);

    const stockouts = alerts.filter((a) => a.type === "inventory-stockout");
    expect(stockouts).toHaveLength(1);
    expect(stockouts[0].severity).toBe("urgent");
    expect(stockouts[0].message).toContain("Doodle Pad");
    expect(stockouts[0].message).toContain("Sticker Set");
  });

  it("tells you to pull ad spend off a stocked-out SKU", () => {
    const alerts = runInventoryChecks([
      item({ quantity: 0, unitsSoldLast30d: 30 }),
    ]);
    expect(alerts[0].message.toLowerCase()).toContain("ad");
  });

  it("reports days of cover on low-stock items so the number is actionable", () => {
    const alerts = runInventoryChecks([
      item({ quantity: 10, unitsSoldLast30d: 30 }),
    ]);
    const low = alerts.find((a) => a.type === "inventory-low-cover");
    expect(low).toBeDefined();
    expect(low!.severity).toBe("warning");
    expect(low!.message).toContain("10 days");
  });

  it("caps the low-cover roll-up and says how many were omitted", () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      item({
        variantId: `v${i}`,
        productTitle: `Product ${i}`,
        quantity: 5,
        unitsSoldLast30d: 30,
      })
    );

    const low = runInventoryChecks(many).find((a) => a.type === "inventory-low-cover")!;
    expect(low.message).toContain("Product 0");
    expect(low.message).not.toContain("Product 8");
    expect(low.message).toContain("4 more");
  });

  it("ranks low-cover items by urgency — fewest days of cover first", () => {
    const low = runInventoryChecks([
      item({ variantId: "1", productTitle: "Roomy", quantity: 12, unitsSoldLast30d: 30 }),
      item({ variantId: "2", productTitle: "Critical", quantity: 1, unitsSoldLast30d: 30 }),
    ]).find((a) => a.type === "inventory-low-cover")!;

    expect(low.message.indexOf("Critical")).toBeLessThan(low.message.indexOf("Roomy"));
  });

  it("surfaces slow movers as an info-level bundling opportunity", () => {
    const alerts = runInventoryChecks([
      item({ productTitle: "Dead Stock", quantity: 300, unitsSoldLast30d: 0 }),
    ]);
    const slow = alerts.find((a) => a.type === "inventory-slow-mover")!;
    expect(slow.severity).toBe("info");
    expect(slow.message).toContain("Dead Stock");
  });

  it("does not alert on untracked or archived variants", () => {
    expect(
      runInventoryChecks([
        item({ variantId: "1", tracked: false, quantity: 0, unitsSoldLast30d: 30 }),
        item({ variantId: "2", productStatus: "ARCHIVED", quantity: 0, unitsSoldLast30d: 30 }),
      ])
    ).toEqual([]);
  });
});
