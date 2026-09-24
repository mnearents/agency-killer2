import { describe, it, expect } from "vitest";
import { transformVariant , parseUnitCostCents } from "@/domain/inventory/sync-transform";
import type { ShopifyApiVariant } from "@/integrations/shopify-api";

const syncedAt = new Date("2026-09-01T13:15:00Z");

function raw(overrides: Partial<ShopifyApiVariant> = {}): ShopifyApiVariant {
  return {
    id: "gid://shopify/ProductVariant/111",
    title: "Default Title",
    sku: "RAD-001",
    inventoryQuantity: 42,
    price: "29.99",
    inventoryItem: { id: "gid://shopify/InventoryItem/222", tracked: true, unitCost: null , weightValue: null, weightUnit: null},
    product: {
      id: "gid://shopify/Product/999",
      title: "Really Awesome Doodles",
      status: "ACTIVE",
      productType: "Subscription",
    },
    ...overrides,
  };
}

describe("transformVariant", () => {
  it("maps a variant onto a schema-valid inventory row", () => {
    const row = transformVariant(raw(), syncedAt);

    expect(row.id).toBe("gid://shopify/ProductVariant/111");
    expect(row.productId).toBe("gid://shopify/Product/999");
    expect(row.productTitle).toBe("Really Awesome Doodles");
    expect(row.variantTitle).toBe("Default Title");
    expect(row.sku).toBe("RAD-001");
    expect(row.quantity).toBe(42);
    expect(row.productStatus).toBe("ACTIVE");
    expect(row.productType).toBe("Subscription");
    expect(row.syncedAt).toBe(syncedAt);
  });

  it("converts the price string to cents", () => {
    expect(transformVariant(raw({ price: "29.99" }), syncedAt).priceCents).toBe(2999);
  });

  it("stores tracked as 1/0 to match the schema's integer boolean convention", () => {
    const item = (tracked: boolean) => ({
      id: "gid://shopify/InventoryItem/222", tracked, unitCost: null,
      weightValue: null, weightUnit: null,
    });
    expect(transformVariant(raw({ inventoryItem: item(true) }), syncedAt).tracked).toBe(1);
    expect(transformVariant(raw({ inventoryItem: item(false) }), syncedAt).tracked).toBe(0);
  });

  it("treats a missing inventoryItem as untracked so it cannot raise a false stockout", () => {
    expect(transformVariant(raw({ inventoryItem: null }), syncedAt).tracked).toBe(0);
  });

  it("defaults a null inventoryQuantity to 0", () => {
    expect(transformVariant(raw({ inventoryQuantity: null }), syncedAt).quantity).toBe(0);
  });

  it("preserves negative (oversold) quantities rather than clamping them", () => {
    expect(transformVariant(raw({ inventoryQuantity: -4 }), syncedAt).quantity).toBe(-4);
  });

  it("falls back to ARCHIVED when the parent product is missing", () => {
    const row = transformVariant(raw({ product: null }), syncedAt);
    expect(row.productId).toBeNull();
    expect(row.productStatus).toBe("ARCHIVED");
  });

  /**
   * Two variants sharing one inventoryItem id sell the same physical units.
   * Without this field the only way to spot that is a title regex, which is
   * what #9 explicitly ruled out.
   */
  it("records the inventory item id, which identifies the shared stock pool", () => {
    const row = transformVariant(
      raw({ inventoryItem: { id: "gid://shopify/InventoryItem/555", tracked: true, unitCost: null , weightValue: null, weightUnit: null} }),
      syncedAt
    );
    expect(row.inventoryItemId).toBe("gid://shopify/InventoryItem/555");
  });

  it("leaves the inventory item id null when Shopify returns no inventoryItem", () => {
    expect(transformVariant(raw({ inventoryItem: null }), syncedAt).inventoryItemId).toBeNull();
  });
});

/**
 * ─── Cost per item (#34) ──────────────────────────────────────────────
 *
 * The input every cost-of-delivery figure rests on. Nothing synced it, so no
 * margin could be computed at all.
 *
 * The one rule that matters: a missing cost stays missing. A planner with
 * nothing entered and a printable that genuinely costs nothing are different
 * facts, and defaulting the first to 0 makes every margin over it quietly
 * optimistic with nothing to notice.
 */
describe("parseUnitCostCents", () => {
  it("converts a decimal string to cents", () => {
    expect(parseUnitCostCents("12.50")).toBe(1250);
    expect(parseUnitCostCents("7")).toBe(700);
  });

  it("rounds rather than truncating a third decimal", () => {
    expect(parseUnitCostCents("1.005")).toBe(101);
    expect(parseUnitCostCents("1.004")).toBe(100);
  });

  it("keeps a genuine zero as zero", () => {
    expect(parseUnitCostCents("0.0")).toBe(0);
    expect(parseUnitCostCents("0")).toBe(0);
  });

  // The distinction the whole column exists to preserve.
  it("keeps a missing cost missing rather than defaulting it to zero", () => {
    expect(parseUnitCostCents(null)).toBeNull();
    expect(parseUnitCostCents("")).toBeNull();
    expect(parseUnitCostCents("   ")).toBeNull();
  });

  it("refuses an unparseable amount rather than recording NaN", () => {
    expect(parseUnitCostCents("twelve fifty")).toBeNull();
    expect(parseUnitCostCents("12.50 USD")).toBeNull();
  });
});

describe("transformVariant: cost", () => {
  const variant = (unitCost: string | null) => ({
    id: "gid://shopify/ProductVariant/1",
    title: "Default",
    sku: "SKU1",
    inventoryQuantity: 3,
    price: "45.00",
    inventoryItem: {
      id: "gid://shopify/InventoryItem/1", tracked: true, unitCost,
      weightValue: null, weightUnit: null,
    },
    product: { id: "gid://shopify/Product/1", title: "Planner", status: "ACTIVE", productType: "Planners" },
  });

  it("carries the cost through to the row", () => {
    expect(transformVariant(variant("12.50"), syncedAt).unitCostCents).toBe(1250);
  });

  it("records no cost as null", () => {
    expect(transformVariant(variant(null), syncedAt).unitCostCents).toBeNull();
  });

  it("records null for a variant with no inventory item at all", () => {
    const v = { ...variant(null), inventoryItem: null };
    expect(transformVariant(v, syncedAt).unitCostCents).toBeNull();
  });
});

import { toPounds, weightState } from "@/domain/shopify/weight";

describe("transformVariant: weight", () => {
  const variant = (weightValue: number | null, weightUnit: string | null) => ({
    id: "gid://shopify/ProductVariant/1",
    title: "Default",
    sku: "SKU1",
    inventoryQuantity: 3,
    price: "45.00",
    inventoryItem: {
      id: "gid://shopify/InventoryItem/1", tracked: true, unitCost: null, weightValue, weightUnit,
    },
    product: { id: "gid://shopify/Product/1", title: "Planner", status: "ACTIVE", productType: "Planners" },
  });

  // The live catalogue mixes all three across 535 variants, so a raw value is
  // meaningless without its unit and two raw values cannot be compared.
  it("normalises each unit the catalogue actually uses", () => {
    expect(transformVariant(variant(2, "POUNDS"), syncedAt).weightLb).toBe(2);
    expect(transformVariant(variant(16, "OUNCES"), syncedAt).weightLb).toBe(1);
    expect(transformVariant(variant(817, "GRAMS"), syncedAt).weightLb).toBeCloseTo(1.8012, 3);
  });

  it("keeps the raw value and unit as Shopify holds them", () => {
    const row = transformVariant(variant(817, "GRAMS"), syncedAt);
    expect(row.weightValue).toBe(817);
    expect(row.weightUnit).toBe("GRAMS");
  });

  // A unit nobody mapped, treated as pounds, would rate a 200-gram notepad at
  // the top of the Media Mail card.
  it("refuses to guess at an unmapped unit", () => {
    expect(transformVariant(variant(5, "STONES"), syncedAt).weightLb).toBeNull();
    expect(transformVariant(variant(5, null), syncedAt).weightLb).toBeNull();
  });

  it("records a missing weight as null", () => {
    expect(transformVariant(variant(null, "POUNDS"), syncedAt).weightLb).toBeNull();
  });
});

describe("toPounds and weightState", () => {
  it("rejects a negative weight rather than converting it", () => {
    expect(toPounds(-1, "POUNDS")).toBeNull();
  });

  // Zero is a real answer for a digital product and must not read as missing.
  it("keeps zero as zero, distinct from unknown", () => {
    expect(toPounds(0, "POUNDS")).toBe(0);
    expect(weightState(0)).toBe("zero");
    expect(weightState(null)).toBe("unknown");
    expect(weightState(1.5)).toBe("usable");
  });
});
