import { describe, it, expect } from "vitest";
import { formatInventoryOverview } from "@/domain/inventory/format";
import type { InventoryItem } from "@/domain/inventory/checks";

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    variantId: "1",
    productTitle: "Really Awesome Doodles",
    variantTitle: "Default",
    sku: "RAD-001",
    quantity: 100,
    priceCents: 2000,
    tracked: true,
    productStatus: "ACTIVE",
    unitsSoldLast30d: 30,
    unitsSoldLast12m: 365,
    ...overrides,
  };
}

describe("formatInventoryOverview", () => {
  it("says so plainly when there is no inventory data yet", () => {
    expect(formatInventoryOverview([])).toContain("No inventory data");
  });

  it("reassures when every tracked product is healthy", () => {
    const out = formatInventoryOverview([item(), item({ variantId: "2" })]);
    expect(out).toContain("2 products");
    expect(out.toLowerCase()).toContain("healthy");
  });

  it("counts only tracked, active variants — not archived or untracked ones", () => {
    const out = formatInventoryOverview([
      item({ variantId: "1" }),
      item({ variantId: "2", tracked: false }),
      item({ variantId: "3", productStatus: "ARCHIVED" }),
    ]);
    expect(out).toContain("1 product");
    expect(out).not.toContain("3 products");
  });

  it("leads with out-of-stock items", () => {
    const out = formatInventoryOverview([
      item({ variantId: "1", productTitle: "Sold Out Pad", quantity: 0, unitsSoldLast30d: 30 }),
      item({ variantId: "2", productTitle: "Low Pad", quantity: 5, unitsSoldLast30d: 30 }),
    ]);
    expect(out).toContain("Sold Out Pad");
    expect(out).toContain("Low Pad");
    expect(out.indexOf("Sold Out Pad")).toBeLessThan(out.indexOf("Low Pad"));
  });

  it("avoids terminal-style output and jargon so Tara can read it", () => {
    const out = formatInventoryOverview([
      item({ quantity: 0, unitsSoldLast30d: 30 }),
    ]);
    expect(out).not.toMatch(/undefined|null|NaN|\[object/);
  });
});
