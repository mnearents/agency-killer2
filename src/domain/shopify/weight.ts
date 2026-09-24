/**
 * Normalising Shopify variant weights.
 *
 * Shopify stores whatever unit the product was created with, and this
 * catalogue uses three: GRAMS, POUNDS and OUNCES, mixed across 535 variants.
 * A rate card is priced in pounds, so a raw value is unusable without its unit
 * and comparing two raw values is meaningless.
 *
 * Both are stored: the value and unit as Shopify holds them, and a derived
 * `weightLb`. The raw pair is the record; the derived one is the thing
 * arithmetic happens on.
 */

export const POUNDS_PER = {
  POUNDS: 1,
  OUNCES: 1 / 16,
  GRAMS: 1 / 453.59237,
  KILOGRAMS: 2.20462262,
} as const;

export type ShopifyWeightUnit = keyof typeof POUNDS_PER;

export function isKnownWeightUnit(unit: string | null): unit is ShopifyWeightUnit {
  return unit !== null && unit in POUNDS_PER;
}

/**
 * Converts to pounds, or null when the unit is one nobody has mapped.
 *
 * Null rather than a guess: a unit this does not know would otherwise be
 * treated as pounds, and a 200-gram notepad recorded as 200 lb would rate at
 * the top of the Media Mail card and look like the most expensive thing in the
 * catalogue.
 */
export function toPounds(value: number | null, unit: string | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  if (!isKnownWeightUnit(unit)) return null;
  return Number((value * POUNDS_PER[unit]).toFixed(4));
}

/**
 * Whether a weight can be used to rate postage.
 *
 * Zero is a real answer — a digital product weighs nothing and ships nothing —
 * and is deliberately NOT treated as missing. But it also cannot be rated, so
 * the two states are returned separately rather than collapsed into a
 * falsy check.
 */
export type WeightState = "usable" | "zero" | "unknown";

export function weightState(weightLb: number | null): WeightState {
  if (weightLb === null) return "unknown";
  return weightLb > 0 ? "usable" : "zero";
}
