/**
 * Whose stock a product is.
 *
 * `Boon Ties` drop-ships the coloring ties. They sell through the Rad & Happy
 * storefront but sit on someone else's shelf, are bought with someone else's
 * money and are replenished by someone else — so counting them as inventory
 * overstates both stock on hand and capital tied up, and their COGS is not a
 * Rad & Happy cost at all.
 *
 * Declared rather than inferred. Vendor is free text in Shopify, so a rule
 * like "anything that is not Printify" would silently admit the next
 * drop-shipper someone adds.
 */

/** Vendors whose stock Rad & Happy actually owns. */
export const OWNED_VENDORS = ["Rad & Happy"] as const;

/**
 * Vendors seen on the live catalogue that are NOT ours, kept so the list is a
 * record rather than an absence. `Boon Ties` drop-ships; the rest are apps
 * (`re:do` and `Route` are insurance, `Printify` is print-on-demand) and are
 * all inactive.
 */
export const KNOWN_EXTERNAL_VENDORS = ["Boon Ties", "re:do", "Route", "Printify", "New"] as const;

/** Vendor is free text, so matching tolerates case and surrounding space. */
function normalise(vendor: string): string {
  return vendor.trim().toLowerCase();
}

const OWNED = new Set(OWNED_VENDORS.map(normalise));

/**
 * Whether Rad & Happy owns this stock.
 *
 * A missing vendor counts as OURS. Every one of the 283 own-brand products
 * carries the vendor, so a blank is a data gap on a product that is almost
 * certainly ours — and excluding it would quietly drop real inventory, which
 * is worse than including a drop-shipped item by mistake. The opposite default
 * would make a Shopify field someone forgot to fill in look like someone
 * else's stock.
 */
export function isOwnedVendor(vendor: string | null | undefined): boolean {
  if (vendor === null || vendor === undefined || vendor.trim() === "") return true;
  return OWNED.has(normalise(vendor));
}

export interface OwnershipSplit<T> {
  owned: T[];
  external: T[];
  /** Per external vendor, how many were set aside. Reported, never silent. */
  excludedByVendor: Record<string, number>;
}

/**
 * Splits a list into ours and someone else's.
 *
 * Returns both halves rather than filtering, because an exclusion nobody can
 * see is how a number quietly changes meaning. Whatever consumes this is
 * expected to say how many it set aside.
 */
export function splitByOwnership<T>(
  items: T[],
  vendorOf: (item: T) => string | null | undefined,
): OwnershipSplit<T> {
  const owned: T[] = [];
  const external: T[] = [];
  const excludedByVendor: Record<string, number> = {};

  for (const item of items) {
    if (isOwnedVendor(vendorOf(item))) {
      owned.push(item);
    } else {
      external.push(item);
      const key = (vendorOf(item) ?? "(unknown)").trim();
      excludedByVendor[key] = (excludedByVendor[key] ?? 0) + 1;
    }
  }

  return { owned, external, excludedByVendor };
}
