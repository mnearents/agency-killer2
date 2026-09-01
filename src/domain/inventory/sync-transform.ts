/**
 * Inventory sync transform — maps raw Shopify variants into schema-valid rows.
 *
 * Money follows the codebase rule: decimal string → cents.
 * Booleans follow the schema convention: stored as 0/1 integers.
 *
 * A variant with no inventoryItem is recorded as untracked, never tracked —
 * failing closed here keeps a missing field from becoming a false stockout.
 */

import type { ShopifyApiVariant } from "@/integrations/shopify-api";
import type { NewShopifyInventoryRow } from "@/db/schema";

function dollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

export function transformVariant(
  raw: ShopifyApiVariant,
  syncedAt: Date
): NewShopifyInventoryRow {
  return {
    id: raw.id,
    productId: raw.product?.id ?? null,
    productTitle: raw.product?.title ?? "Unknown product",
    variantTitle: raw.title ?? null,
    sku: raw.sku ?? null,
    quantity: raw.inventoryQuantity ?? 0,
    tracked: raw.inventoryItem?.tracked ? 1 : 0,
    // No parent product means it isn't sellable — treat it like an archived one.
    productStatus: raw.product?.status ?? "ARCHIVED",
    productType: raw.product?.productType ?? null,
    priceCents: dollarsToCents(raw.price),
    rawJson: raw,
    syncedAt,
  };
}
