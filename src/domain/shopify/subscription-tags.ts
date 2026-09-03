/**
 * Identifies subscription orders from Shopify order tags.
 *
 * This is all that survives of the old price-inference LTV module. Subscription
 * analytics now read Seal directly (see src/domain/subscriptions/), where tier,
 * cohort and cancellation are recorded facts rather than guesses from an order
 * total. Order tags remain the only way to tell whether a *Shopify order* was a
 * recurring charge, which is what the order sync needs.
 */

const SUBSCRIPTION_TAGS = ["recurring-order", "colorhappy-first", "rad-first"];

export function isSubscriptionOrder(tags: unknown): boolean {
  if (!Array.isArray(tags)) return false;
  return tags.some((tag) => SUBSCRIPTION_TAGS.includes(tag));
}
