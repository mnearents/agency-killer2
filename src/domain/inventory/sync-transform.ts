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

/**
 * Shopify returns the cost as a decimal string, or null when none is set.
 *
 * A missing cost stays missing. Defaulting it to 0 would make a planner with
 * no cost entered indistinguishable from a printable that genuinely costs
 * nothing, and every margin computed over it would be quietly optimistic.
 */
export function parseUnitCostCents(amount: string | null): number | null {
  if (amount === null) return null;
  const text = amount.trim();
  if (text === "") return null;

  // Parsed from the digits rather than via `Number(x) * 100`. Floats lose
  // this: 1.005 * 100 is 100.49999999999999, which rounds to 100 and quietly
  // undercharges the cost by a cent. Money is integer cents here precisely so
  // that cannot happen, and the parse has to hold the same line.
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;

  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  // A third decimal rounds on its own digit, not on a float's approximation.
  const rounded = fraction.length > 2 && Number(fraction[2]) >= 5 ? cents + 1 : cents;

  return sign === "-" ? -rounded : rounded;
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
    inventoryItemId: raw.inventoryItem?.id ?? null,
    // Parsed to cents, and null when nothing is recorded — never 0, which is a
    // real and different answer for a digital product.
    unitCostCents: parseUnitCostCents(raw.inventoryItem?.unitCost ?? null),
    // No parent product means it isn't sellable — treat it like an archived one.
    productStatus: raw.product?.status ?? "ARCHIVED",
    productType: raw.product?.productType ?? null,
    priceCents: dollarsToCents(raw.price),
    rawJson: raw,
    syncedAt,
  };
}
