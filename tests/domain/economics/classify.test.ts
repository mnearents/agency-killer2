import { describe, it, expect } from "vitest";
import { classifyBusinessLine, type OrderLineFacts } from "@/domain/economics/classify";
import { lineOf } from "@/domain/economics/queries";

const facts = (over: Partial<OrderLineFacts> = {}): OrderLineFacts => ({
  hasSubscriptionType: false,
  hasUntypedWithoutInventory: false,
  hasTrackedInventory: false,
  hasKnownPhysicalType: false,
  ...over,
});

/**
 * ─── Which line an order belongs to (#43) ─────────────────────────────
 *
 * This used to be `product_type` alone, with everything unrecognised falling
 * through to `digital`. Against production that is 2,042 line items and
 * $52,630 landing in the wrong line:
 *
 *   product_type = ''   1,904 lines  $49,793  — all have an inventory row,
 *                                               1,742 of them tracked. Wall
 *                                               calendars, notepads, stickers,
 *                                               a quilt. Physical goods whose
 *                                               metadata is blank in Shopify.
 *   product_type NULL     138 lines   $2,837  — no inventory row at all. Spark
 *                                               to Studio upgrades, prorated
 *                                               plan changes, subscription
 *                                               gifts. Not products.
 *
 * Both were classified as digital, which is the one line neither belongs to.
 * The field is blank at the Shopify product level, so no re-sync fixes it —
 * see #43. Until roughly 30 products are edited in admin, `tracked` is the
 * sounder classifier: it is populated on every variant that has an inventory
 * row, and only a physical thing has a stock count.
 */
describe("classifyBusinessLine", () => {
  it("calls an order with a subscription product a subscription", () => {
    expect(classifyBusinessLine(facts({ hasSubscriptionType: true }))).toBe("subscription");
  });

  /**
   * A "RAD Studio Upgrade: Spark Monthly → Studio Monthly" line has no
   * product_type and no inventory row because it was never a product. It is a
   * subscription event, and classifying it by the absence of a type put it
   * wherever the leftover bucket went.
   */
  it("calls an untyped line with no inventory row a subscription", () => {
    expect(classifyBusinessLine(facts({ hasUntypedWithoutInventory: true }))).toBe("subscription");
  });

  it("calls a tracked item physical even with no product type", () => {
    expect(classifyBusinessLine(facts({ hasTrackedInventory: true }))).toBe("physical");
  });

  it("calls a known physical type physical even when nothing is tracked", () => {
    expect(classifyBusinessLine(facts({ hasKnownPhysicalType: true }))).toBe("physical");
  });

  it("calls an order with neither digital", () => {
    expect(classifyBusinessLine(facts())).toBe("digital");
  });

  /**
   * Order matters. A subscription order that also contains a tracked item — a
   * gift box with a plan, say — is a subscription: that is the line the
   * recurring revenue belongs to, and #34 splits by what is being sold.
   */
  it("puts a subscription ahead of a physical item on the same order", () => {
    expect(
      classifyBusinessLine(facts({ hasSubscriptionType: true, hasTrackedInventory: true }))
    ).toBe("subscription");
  });

  it("puts a plan change ahead of a physical item on the same order", () => {
    expect(
      classifyBusinessLine(facts({ hasUntypedWithoutInventory: true, hasTrackedInventory: true }))
    ).toBe("subscription");
  });

  /**
   * Against production, nine line items are typed `Activity Books` — which is
   * in the digital list — and carry `tracked = 1`. One product: "Alphabet How
   * To Draw Activity Book". A PDF does not have a stock count, so the stock
   * count wins over the type list.
   *
   * Nine line items either way, so this is not load-bearing money. It is
   * load-bearing because the rule has to be stated rather than left to
   * whichever branch happens to come first.
   */
  it("lets a stock count win over a digital product type", () => {
    expect(classifyBusinessLine(facts({ hasTrackedInventory: true }))).toBe("physical");
  });

  // Digital is the residue, and must stay reachable: a printable with a type
  // and no inventory row is genuinely digital, not merely unclassified.
  it("keeps digital reachable for an untyped line that does have an inventory row", () => {
    expect(
      classifyBusinessLine(facts({ hasUntypedWithoutInventory: false, hasTrackedInventory: false }))
    ).toBe("digital");
  });
});

/**
 * The snake_case row from Postgres has to reach the camelCase rule.
 *
 * A misspelled key reads as `undefined`, which is falsy, so a typo in
 * `has_tracked_inventory` moves every physical order into digital and changes
 * nothing else about the output — no error, no empty result, just a different
 * and entirely plausible set of numbers.
 */
describe("lineOf: the row's flags reach the rule", () => {
  const row = (over: Record<string, boolean> = {}) => ({
    has_subscription_type: false,
    has_untyped_without_inventory: false,
    has_tracked_inventory: false,
    has_known_physical_type: false,
    ...over,
  });

  it("carries has_subscription_type", () => {
    expect(lineOf(row({ has_subscription_type: true }))).toBe("subscription");
  });

  it("carries has_untyped_without_inventory", () => {
    expect(lineOf(row({ has_untyped_without_inventory: true }))).toBe("subscription");
  });

  it("carries has_tracked_inventory", () => {
    expect(lineOf(row({ has_tracked_inventory: true }))).toBe("physical");
  });

  it("carries has_known_physical_type", () => {
    expect(lineOf(row({ has_known_physical_type: true }))).toBe("physical");
  });

  it("falls to digital when every flag is false", () => {
    expect(lineOf(row())).toBe("digital");
  });
});
