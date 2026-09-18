/**
 * Which business line an order belongs to.
 *
 * This lives in TypeScript rather than in the CASE expression it replaces so
 * that it can be tested. The query returns four booleans per order; the rule
 * over them is here.
 *
 * ## Why it is not `product_type` alone
 *
 * It was, with everything unrecognised falling through to `digital`. Against
 * production that put 2,042 line items and $52,630 in the wrong line:
 *
 *   product_type = ''   1,904 lines  $49,793  every one has an inventory row
 *                                             and 1,742 are tracked — wall
 *                                             calendars, notepads, stickers,
 *                                             a quilt. Physical goods whose
 *                                             Shopify metadata is blank.
 *   product_type NULL     138 lines   $2,837  no inventory row at all. Spark
 *                                             to Studio upgrades, prorated
 *                                             plan changes, subscription
 *                                             gifts. Never products.
 *
 * The field is blank at the Shopify product level, so no re-sync fixes it and
 * roughly 30 products need editing in admin (#43). Until then `tracked` is the
 * sounder classifier: it is populated on every variant with an inventory row,
 * and only a physical thing has a stock count.
 */

import type { BusinessLine } from "./queries";

export interface OrderLineFacts {
  /** Any line with `product_type = 'Subscription'`. */
  hasSubscriptionType: boolean;
  /**
   * Any line with a NULL product_type and no inventory row.
   *
   * Both halves matter. NULL alone would be "we do not know"; NULL with no
   * inventory row is a line that was never a product, which against production
   * means a plan change or a subscription gift.
   */
  hasUntypedWithoutInventory: boolean;
  /** Any line whose variant has `tracked = 1`. Only physical goods have stock. */
  hasTrackedInventory: boolean;
  /** Any line with a product_type that is neither a digital type nor Subscription. */
  hasKnownPhysicalType: boolean;
}

export function classifyBusinessLine(facts: OrderLineFacts): BusinessLine {
  // Subscription first: an order carrying a plan is a subscription order even
  // when a physical gift rides along with it, because the recurring revenue is
  // the thing being sold.
  if (facts.hasSubscriptionType || facts.hasUntypedWithoutInventory) return "subscription";

  // A stock count outranks the digital type list. Nine line items are typed
  // `Activity Books` and tracked — one printed book — and a PDF does not have
  // a stock count.
  if (facts.hasTrackedInventory || facts.hasKnownPhysicalType) return "physical";

  return "digital";
}
