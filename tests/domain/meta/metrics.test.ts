import { describe, it, expect } from "vitest";
import {
  computeMetrics,
  aggregateAndCompute,
  computeLtvAdjustedRoas,
  type InsightRow,
} from "@/domain/meta/metrics";

const TYPICAL_ROW: InsightRow = {
  spendCents: 5000, // $50.00
  impressions: 10000,
  clicks: 200,
  reach: 8000,
  purchases: 5,
  purchaseValueCents: 15000, // $150.00
  addToCart: 30,
  initiateCheckout: 15,
};

describe("computeMetrics: basic calculations", () => {
  it("converts spend and revenue from cents to dollars", () => {
    const m = computeMetrics(TYPICAL_ROW);
    expect(m.spendDollars).toBe(50);
    expect(m.revenueDollars).toBe(150);
  });

  it("computes ROAS as revenue / spend", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // $150 / $50 = 3.0x
    expect(m.roas).toBe(3.0);
  });

  it("computes cost per purchase in dollars", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // $50 / 5 purchases = $10/purchase
    expect(m.costPerPurchaseDollars).toBe(10);
  });

  it("computes CTR as clicks / impressions * 100", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // 200 / 10000 * 100 = 2.0%
    expect(m.ctr).toBe(2.0);
  });

  it("computes CPM as spend / impressions * 1000", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // $50 / 10000 * 1000 = $5.00
    expect(m.cpm).toBe(5.0);
  });

  it("computes CPC as spend / clicks", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // $50 / 200 = $0.25
    expect(m.cpc).toBe(0.25);
  });

  it("computes conversion rate as purchases / clicks * 100", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // 5 / 200 * 100 = 2.5%
    expect(m.conversionRate).toBe(2.5);
  });

  it("computes add-to-cart rate as addToCart / clicks * 100", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // 30 / 200 * 100 = 15%
    expect(m.addToCartRate).toBe(15);
  });

  it("computes checkout rate as initiateCheckout / addToCart * 100", () => {
    const m = computeMetrics(TYPICAL_ROW);
    // 15 / 30 * 100 = 50%
    expect(m.checkoutRate).toBe(50);
  });
});

describe("computeMetrics: zero/edge cases", () => {
  it("returns null ROAS when spend is zero", () => {
    const m = computeMetrics({ ...TYPICAL_ROW, spendCents: 0 });
    expect(m.roas).toBeNull();
  });

  it("returns null costPerPurchase when purchases is zero", () => {
    const m = computeMetrics({ ...TYPICAL_ROW, purchases: 0 });
    expect(m.costPerPurchaseDollars).toBeNull();
  });

  it("returns null CTR and CPM when impressions is zero", () => {
    const m = computeMetrics({ ...TYPICAL_ROW, impressions: 0 });
    expect(m.ctr).toBeNull();
    expect(m.cpm).toBeNull();
  });

  it("returns null CPC and conversion/ATC rates when clicks is zero", () => {
    const m = computeMetrics({ ...TYPICAL_ROW, clicks: 0 });
    expect(m.cpc).toBeNull();
    expect(m.conversionRate).toBeNull();
    expect(m.addToCartRate).toBeNull();
  });

  it("returns null checkout rate when addToCart is zero", () => {
    const m = computeMetrics({ ...TYPICAL_ROW, addToCart: 0 });
    expect(m.checkoutRate).toBeNull();
  });

  it("handles all zeros without crashing", () => {
    const m = computeMetrics({
      spendCents: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      purchases: 0,
      purchaseValueCents: 0,
      addToCart: 0,
      initiateCheckout: 0,
    });
    expect(m.spendDollars).toBe(0);
    expect(m.revenueDollars).toBe(0);
    expect(m.roas).toBeNull();
    expect(m.costPerPurchaseDollars).toBeNull();
  });
});

describe("aggregateAndCompute: sums rows then computes", () => {
  it("sums metrics across multiple rows", () => {
    const rows: InsightRow[] = [
      { ...TYPICAL_ROW, spendCents: 3000, purchaseValueCents: 9000, purchases: 3 },
      { ...TYPICAL_ROW, spendCents: 2000, purchaseValueCents: 6000, purchases: 2 },
    ];
    const m = aggregateAndCompute(rows);
    expect(m.spendDollars).toBe(50); // 3000 + 2000 = 5000 cents
    expect(m.revenueDollars).toBe(150); // 9000 + 6000 = 15000 cents
    expect(m.roas).toBe(3.0);
  });

  it("returns zero metrics for empty array", () => {
    const m = aggregateAndCompute([]);
    expect(m.spendDollars).toBe(0);
    expect(m.revenueDollars).toBe(0);
    expect(m.roas).toBeNull();
  });
});

describe("computeLtvAdjustedRoas: subscription LTV", () => {
  it("computes LTV-adjusted ROAS for subscription campaigns", () => {
    // Spent $100, got $50 in immediate purchase value (0.5x raw ROAS)
    // But 5 of those purchases were $8/mo subscriptions, avg 6 months retention
    // LTV per sub = $8 * 6 = $48
    // Total LTV = $50 (immediate) + 5 * $48 (subscription LTV) = $290
    // LTV-adjusted ROAS = $290 / $100 = 2.9x
    const result = computeLtvAdjustedRoas(
      10000, // $100 spend
      5000, // $50 immediate purchase value
      5, // 5 subscription purchases
      800, // $8/mo
      6 // 6 months avg retention
    );

    expect(result.rawRoas).toBe(0.5);
    expect(result.ltvAdjustedRoas).toBeCloseTo(2.9);
    expect(result.profitableWithLtv).toBe(true);
  });

  it("shows unprofitable even with LTV when spend is too high", () => {
    // Spent $500, got $50 immediate, 2 subs at $8/mo for 3 months
    // LTV = $50 + 2 * $24 = $98
    // LTV ROAS = $98 / $500 = 0.196
    const result = computeLtvAdjustedRoas(
      50000, // $500
      5000, // $50
      2, // 2 subs
      800, // $8/mo
      3 // 3 months
    );

    expect(result.rawRoas).toBe(0.1);
    expect(result.ltvAdjustedRoas).toBeCloseTo(0.196);
    expect(result.profitableWithLtv).toBe(false);
  });

  it("returns null ROAS values when spend is zero", () => {
    const result = computeLtvAdjustedRoas(0, 5000, 2, 800, 6);
    expect(result.rawRoas).toBeNull();
    expect(result.ltvAdjustedRoas).toBeNull();
    expect(result.profitableWithLtv).toBe(false);
  });

  it("handles zero subscriptions — LTV equals immediate value", () => {
    const result = computeLtvAdjustedRoas(
      10000, // $100
      20000, // $200
      0, // no subs
      800,
      6
    );

    expect(result.rawRoas).toBe(2.0);
    expect(result.ltvAdjustedRoas).toBe(2.0); // same as raw
    expect(result.profitableWithLtv).toBe(true);
  });
});
