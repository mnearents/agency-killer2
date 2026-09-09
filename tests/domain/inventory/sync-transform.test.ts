import { describe, it, expect } from "vitest";
import { transformVariant } from "@/domain/inventory/sync-transform";
import type { ShopifyApiVariant } from "@/integrations/shopify-api";

const syncedAt = new Date("2026-09-01T13:15:00Z");

function raw(overrides: Partial<ShopifyApiVariant> = {}): ShopifyApiVariant {
  return {
    id: "gid://shopify/ProductVariant/111",
    title: "Default Title",
    sku: "RAD-001",
    inventoryQuantity: 42,
    price: "29.99",
    inventoryItem: { id: "gid://shopify/InventoryItem/222", tracked: true },
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
    const item = (tracked: boolean) => ({ id: "gid://shopify/InventoryItem/222", tracked });
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
      raw({ inventoryItem: { id: "gid://shopify/InventoryItem/555", tracked: true } }),
      syncedAt
    );
    expect(row.inventoryItemId).toBe("gid://shopify/InventoryItem/555");
  });

  it("leaves the inventory item id null when Shopify returns no inventoryItem", () => {
    expect(transformVariant(raw({ inventoryItem: null }), syncedAt).inventoryItemId).toBeNull();
  });
});
