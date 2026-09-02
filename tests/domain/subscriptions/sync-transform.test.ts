import { describe, it, expect } from "vitest";
import {
  resolveVariant,
  parseMoneyToCents,
  toUtc,
  normaliseErrorCode,
  deriveNextBillingDate,
  deriveDunning,
  isPriceAnomaly,
  transformSubscription,
  summariseTransform,
} from "@/domain/subscriptions/sync-transform";
import type { SealSubscription } from "@/integrations/seal-api";

const SYNCED_AT = new Date("2026-09-02T13:20:00Z");

function sub(overrides: Partial<SealSubscription> = {}): SealSubscription {
  return {
    id: 15876884,
    order_id: "7792730308853",
    email: "a@example.com",
    first_name: "A",
    last_name: "B",
    status: "ACTIVE",
    billing_interval: "1 month",
    delivery_interval: "1 month",
    currency: "USD",
    total_value: 8,
    order_placed: "2026-09-02T09:07:47-07:00",
    cancelled_on: "",
    paused_on: "",
    cancellation_reason: "",
    cancellation_scheduled_for: "",
    internal_id: 5627,
    items: [
      {
        id: 1,
        product_id: "9465149784309",
        variant_id: "48093950214389",
        title: "Really Awesome Doodles - Spark",
        variant_sku: "rad-t1",
        quantity: 1,
        price: "8.0",
        selling_plan_id: "10080551157",
        selling_plan_name: "Spark Monthly Plan",
        is_one_time_item: 0,
        requires_shipping: 0,
        taxable: 1,
      },
    ],
    billing_attempts: [],
    ...overrides,
  };
}

describe("parseMoneyToCents", () => {
  it("converts a dollar string to cents", () => {
    expect(parseMoneyToCents("8.0")).toBe(800);
    expect(parseMoneyToCents("144.00")).toBe(14400);
    expect(parseMoneyToCents("5.07")).toBe(507);
  });

  // The docs show final_price as both number and string.
  it("accepts a number as well as a string", () => {
    expect(parseMoneyToCents(120)).toBe(12000);
  });

  it("rounds rather than truncating so a cent is never silently lost", () => {
    expect(parseMoneyToCents("168.135")).toBe(16814);
  });

  // A price we cannot read must not become 0 — that would look like a free
  // subscription and quietly drag MRR down.
  it("returns null for an unparseable price instead of zero", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("n/a")).toBeNull();
    expect(parseMoneyToCents(null)).toBeNull();
    expect(parseMoneyToCents(undefined)).toBeNull();
  });
});

describe("toUtc", () => {
  it("normalises a store-local offset timestamp to UTC", () => {
    // order_placed arrives as -07:00
    expect(toUtc("2026-09-02T09:07:47-07:00")?.toISOString()).toBe("2026-09-02T16:07:47.000Z");
  });

  it("passes through a +00:00 timestamp unchanged", () => {
    expect(toUtc("2026-09-01T13:09:35+00:00")?.toISOString()).toBe("2026-09-01T13:09:35.000Z");
  });

  it("returns null for the empty string Seal uses for absent dates", () => {
    expect(toUtc("")).toBeNull();
    expect(toUtc(undefined)).toBeNull();
  });

  it("returns null for an unparseable date rather than Invalid Date", () => {
    expect(toUtc("not-a-date")).toBeNull();
  });
});

describe("resolveVariant", () => {
  it.each([
    ["36983342497944", "spark", "grandfathered"],
    ["48093950214389", "spark", "current"],
    ["48150148284661", "studio", "grandfathered"],
    ["48125741793525", "studio", "current"],
  ])("maps variant %s to %s/%s", (variantId, tier, cohort) => {
    const r = resolveVariant(variantId);
    expect(r.tier).toBe(tier);
    expect(r.pricingCohort).toBe(cohort);
  });

  it("returns unknown for an unmapped variant", () => {
    const r = resolveVariant("99999999999999");
    expect(r.tier).toBe("unknown");
    expect(r.pricingCohort).toBe("unknown");
  });

  it("returns unknown for a missing variant id", () => {
    expect(resolveVariant("").tier).toBe("unknown");
  });
});

describe("normaliseErrorCode", () => {
  // Seal emits both spellings, with different messages, for the same thing.
  it("collapses the double-underscore fraud variant", () => {
    expect(normaliseErrorCode("FRAUD__SUSPECTED")).toBe("FRAUD_SUSPECTED");
    expect(normaliseErrorCode("FRAUD_SUSPECTED")).toBe("FRAUD_SUSPECTED");
  });

  it("leaves other codes alone", () => {
    expect(normaliseErrorCode("INSUFFICIENT_FUNDS")).toBe("INSUFFICIENT_FUNDS");
  });

  it("returns null for an empty code", () => {
    expect(normaliseErrorCode("")).toBeNull();
  });
});

describe("deriveNextBillingDate", () => {
  it("picks the earliest attempt that has not run yet", () => {
    const d = deriveNextBillingDate([
      { status: "completed", date: "2026-08-01T08:00:00+00:00" },
      { status: "", date: "2026-11-01T08:00:00+00:00" },
      { status: "", date: "2026-10-01T08:00:00+00:00" },
    ] as SealSubscription["billing_attempts"]);
    expect(d?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  // Do not trust array order just because it happens to be sorted today.
  it("ignores completed and errored attempts", () => {
    const d = deriveNextBillingDate([
      { status: "error", date: "2026-09-01T08:00:00+00:00" },
      { status: "", date: "2026-10-01T08:00:00+00:00" },
    ] as SealSubscription["billing_attempts"]);
    expect(d?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  it("returns null when there is no scheduled attempt", () => {
    expect(deriveNextBillingDate([])).toBeNull();
    expect(
      deriveNextBillingDate([
        { status: "completed", date: "2026-08-01T08:00:00+00:00" },
      ] as SealSubscription["billing_attempts"])
    ).toBeNull();
  });
});

describe("deriveDunning", () => {
  it("flags an ACTIVE subscription with an errored attempt", () => {
    const r = deriveDunning("ACTIVE", [
      { status: "error", date: "2026-09-01T08:00:00+00:00", error_code: "INSUFFICIENT_FUNDS", error_message: "Your card has insufficient funds." },
    ] as SealSubscription["billing_attempts"]);
    expect(r.inDunning).toBe(true);
    expect(r.lastErrorCode).toBe("INSUFFICIENT_FUNDS");
    expect(r.lastErrorMessage).toBe("Your card has insufficient funds.");
  });

  // 164 completed attempts carry a stale error_code from an earlier failure.
  // Reading error_code as failure over-reports dunning roughly threefold.
  it("does NOT flag a completed attempt that still carries an error_code", () => {
    const r = deriveDunning("ACTIVE", [
      { status: "completed", date: "2026-08-01T08:00:00+00:00", error_code: "EXPIRED_CARD", error_message: "Your card has expired." },
    ] as SealSubscription["billing_attempts"]);
    expect(r.inDunning).toBe(false);
  });

  it("does not flag a cancelled subscription even with an errored attempt", () => {
    const r = deriveDunning("CANCELLED", [
      { status: "error", date: "2026-09-01T08:00:00+00:00", error_code: "INSUFFICIENT_FUNDS", error_message: "x" },
    ] as SealSubscription["billing_attempts"]);
    expect(r.inDunning).toBe(false);
  });

  it("keeps the most recent error, not the first", () => {
    const r = deriveDunning("ACTIVE", [
      { status: "error", date: "2026-07-01T08:00:00+00:00", error_code: "EXPIRED_CARD", error_message: "old" },
      { status: "error", date: "2026-09-01T08:00:00+00:00", error_code: "CARD_DECLINED", error_message: "new" },
    ] as SealSubscription["billing_attempts"]);
    expect(r.lastErrorCode).toBe("CARD_DECLINED");
  });

  it("normalises the fraud code variant it stores", () => {
    const r = deriveDunning("ACTIVE", [
      { status: "error", date: "2026-09-01T08:00:00+00:00", error_code: "FRAUD__SUSPECTED", error_message: "x" },
    ] as SealSubscription["billing_attempts"]);
    expect(r.lastErrorCode).toBe("FRAUD_SUSPECTED");
  });
});

describe("isPriceAnomaly", () => {
  it.each([
    ["spark", "grandfathered", "1 month", 500],
    ["spark", "grandfathered", "12 month", 5500],
    ["spark", "current", "1 month", 800],
    ["studio", "current", "12 month", 14400],
    ["studio", "grandfathered", "13 month", 12000],
  ])("accepts the expected price for %s/%s/%s", (tier, cohort, interval, cents) => {
    expect(isPriceAnomaly(tier as never, cohort as never, interval, cents)).toBe(false);
  });

  // Proration and partial discounts are normal, not corruption.
  it("accepts prorated amounts within 2x of the expected price", () => {
    expect(isPriceAnomaly("spark", "grandfathered", "1 month", 776)).toBe(false);
    expect(isPriceAnomaly("spark", "grandfathered", "12 month", 7805)).toBe(false);
    expect(isPriceAnomaly("spark", "grandfathered", "12 month", 4732)).toBe(false);
  });

  it.each([
    ["spark", "grandfathered", "12 month", 796300],
    ["studio", "grandfathered", "13 month", 1938200],
    ["spark", "grandfathered", "12 month", 242544],
    ["studio", "grandfathered", "1 month", 12000],
  ])("flags %s/%s/%s at %i cents", (tier, cohort, interval, cents) => {
    expect(isPriceAnomaly(tier as never, cohort as never, interval, cents)).toBe(true);
  });

  it("flags a zero or negative price", () => {
    expect(isPriceAnomaly("spark", "grandfathered", "1 month", 0)).toBe(true);
    expect(isPriceAnomaly("spark", "grandfathered", "1 month", -100)).toBe(true);
  });

  // No expected price means no basis to judge — that is unknown, and unknown
  // must be loud rather than quietly "fine".
  it("flags a price it has no baseline for", () => {
    expect(isPriceAnomaly("unknown", "unknown", "1 month", 500)).toBe(true);
    expect(isPriceAnomaly("spark", "current", "7 month", 800)).toBe(true);
  });

  it("flags a null price", () => {
    expect(isPriceAnomaly("spark", "current", "1 month", null)).toBe(true);
  });
});

describe("transformSubscription", () => {
  it("maps a current-cohort Spark subscription", () => {
    const { row } = transformSubscription(sub(), SYNCED_AT);
    expect(row.id).toBe("15876884");
    expect(row.tier).toBe("spark");
    expect(row.pricingCohort).toBe("current");
    expect(row.billingInterval).toBe("1 month");
    expect(row.billingCadence).toBe("monthly");
    expect(row.priceCents).toBe(800);
    expect(row.status).toBe("ACTIVE");
    expect(row.priceAnomaly).toBe(false);
    expect(row.inDunning).toBe(false);
  });

  it("takes the billing interval from the root field, never from price", () => {
    const { row } = transformSubscription(
      sub({ billing_interval: "12 month", items: [{ ...sub().items[0], price: "5.0" }] }),
      SYNCED_AT
    );
    expect(row.billingCadence).toBe("annual");
  });

  // 56 grandfathered Studio subscriptions bill on a 13-month cycle. Folding
  // them into "annual" would silently change the annual count; dropping them
  // would silently lose them. They get their own bucket.
  it("classifies a 13 month interval as other, not annual", () => {
    const { row } = transformSubscription(sub({ billing_interval: "13 month" }), SYNCED_AT);
    expect(row.billingInterval).toBe("13 month");
    expect(row.billingCadence).toBe("other");
  });

  it("normalises order_placed from store-local to UTC", () => {
    const { row } = transformSubscription(sub(), SYNCED_AT);
    expect(row.orderPlaced?.toISOString()).toBe("2026-09-02T16:07:47.000Z");
  });

  it("records a cancelled subscription with its cancellation date", () => {
    const { row } = transformSubscription(
      sub({ status: "CANCELLED", cancelled_on: "2026-09-01T13:09:35+00:00" }),
      SYNCED_AT
    );
    expect(row.status).toBe("CANCELLED");
    expect(row.cancelledOn?.toISOString()).toBe("2026-09-01T13:09:35.000Z");
  });

  it("marks a migrated record as manual origin and stores no Shopify order id", () => {
    const { row } = transformSubscription(sub({ order_id: "_manual_ftg79" }), SYNCED_AT);
    expect(row.manualOrigin).toBe(true);
    expect(row.shopifyOrderId).toBeNull();
    expect(row.orderId).toBe("_manual_ftg79");
  });

  it("stores a real Shopify order id as a GID so it joins shopify_orders", () => {
    const { row } = transformSubscription(sub(), SYNCED_AT);
    expect(row.manualOrigin).toBe(false);
    expect(row.shopifyOrderId).toBe("gid://shopify/Order/7792730308853");
  });

  // Variant and plan name disagree on ~45 subscriptions. Variant wins.
  it("prefers the variant over a conflicting selling plan name", () => {
    const { row } = transformSubscription(
      sub({
        billing_interval: "1 month",
        items: [
          {
            ...sub().items[0],
            variant_id: "48150148284661", // Studio grandfathered
            selling_plan_name: "Spark Monthly Plan",
            selling_plan_id: "10080551157",
            price: "12.0",
          },
        ],
      }),
      SYNCED_AT
    );
    expect(row.tier).toBe("studio");
    expect(row.pricingCohort).toBe("grandfathered");
    expect(row.sellingPlanName).toBe("Spark Monthly Plan");
    expect(row.planConflict).toBe(true);
  });

  it("keeps an empty selling plan without treating it as a conflict", () => {
    const { row } = transformSubscription(
      sub({ items: [{ ...sub().items[0], selling_plan_id: "", selling_plan_name: "" }] }),
      SYNCED_AT
    );
    expect(row.sellingPlanId).toBeNull();
    expect(row.planConflict).toBe(false);
  });

  it("reports an unmapped variant as a warning rather than failing silently", () => {
    const { row, warning } = transformSubscription(
      sub({ items: [{ ...sub().items[0], variant_id: "99999999999999" }] }),
      SYNCED_AT
    );
    expect(row.tier).toBe("unknown");
    expect(warning).not.toBeNull();
    expect(warning).toContain("99999999999999");
    expect(warning).toContain("10080551157");
    expect(warning).toContain("Spark Monthly Plan");
    expect(warning).toContain("8.0");
  });

  it("produces a snapshot row keyed to the sync date", () => {
    const { snapshot } = transformSubscription(sub(), SYNCED_AT);
    expect(snapshot.snapshotDate).toBe("2026-09-02");
    expect(snapshot.subscriptionId).toBe("15876884");
    expect(snapshot.tier).toBe("spark");
    expect(snapshot.pricingCohort).toBe("current");
    expect(snapshot.status).toBe("ACTIVE");
    expect(snapshot.priceCents).toBe(800);
  });

  // A subscription with no items still has a status worth tracking.
  it("handles a subscription with no items without throwing", () => {
    const { row, warning } = transformSubscription(sub({ items: [] }), SYNCED_AT);
    expect(row.tier).toBe("unknown");
    expect(row.priceCents).toBeNull();
    expect(warning).not.toBeNull();
  });
});

describe("summariseTransform", () => {
  it("counts statuses, dunning, unknowns and anomalies separately", () => {
    const rows = [
      transformSubscription(sub(), SYNCED_AT),
      transformSubscription(sub({ id: 2, status: "CANCELLED", cancelled_on: "2026-09-01T13:09:35+00:00" }), SYNCED_AT),
      transformSubscription(
        sub({
          id: 3,
          billing_attempts: [
            { status: "error", date: "2026-09-01T08:00:00+00:00", error_code: "EXPIRED_CARD", error_message: "x" },
          ] as SealSubscription["billing_attempts"],
        }),
        SYNCED_AT
      ),
      transformSubscription(sub({ id: 4, items: [{ ...sub().items[0], price: "9999.0" }] }), SYNCED_AT),
    ];

    const s = summariseTransform(rows);
    expect(s.total).toBe(4);
    expect(s.byStatus.ACTIVE).toBe(3);
    expect(s.byStatus.CANCELLED).toBe(1);
    expect(s.inDunning).toBe(1);
    expect(s.priceAnomalies).toBe(1);
    expect(s.anomalousTotalCents).toBe(999900);
    expect(s.unknownTier).toBe(0);
  });

  // Anomalous money must not be averaged into the aggregate it corrupts.
  it("excludes anomalous prices from monthly recurring revenue", () => {
    const rows = [
      transformSubscription(sub(), SYNCED_AT), // $8/mo -> 800
      transformSubscription(sub({ id: 4, items: [{ ...sub().items[0], price: "9999.0" }] }), SYNCED_AT),
    ];
    const s = summariseTransform(rows);
    expect(s.mrrCents).toBe(800);
  });

  it("counts an annual subscription as a twelfth of its price toward MRR", () => {
    const rows = [
      transformSubscription(
        sub({ billing_interval: "12 month", items: [{ ...sub().items[0], price: "72.0" }] }),
        SYNCED_AT
      ),
    ];
    expect(summariseTransform(rows).mrrCents).toBe(600);
  });

  it("excludes cancelled subscriptions from MRR", () => {
    const rows = [
      transformSubscription(sub({ status: "CANCELLED", cancelled_on: "2026-09-01T13:09:35+00:00" }), SYNCED_AT),
    ];
    expect(summariseTransform(rows).mrrCents).toBe(0);
  });
});
