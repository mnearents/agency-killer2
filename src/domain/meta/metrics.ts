/**
 * Meta ads derived metrics — pure math, no DB, no model.
 *
 * All money inputs are in CENTS (from the schema). Outputs are in dollars
 * for human readability, clearly named with "Dollars" suffix.
 *
 * ROAS note: Rad & Happy sells subscriptions ($8/mo). A <1x ROAS can be
 * acceptable when LTV exceeds the acquisition cost. The metrics module
 * computes raw ROAS and LTV-adjusted ROAS separately.
 */

export interface InsightRow {
  spendCents: number;
  impressions: number;
  clicks: number;
  reach: number;
  purchases: number;
  purchaseValueCents: number;
  addToCart: number;
  initiateCheckout: number;
}

export interface DerivedMetrics {
  spendDollars: number;
  revenueDollars: number;
  roas: number | null;
  costPerPurchaseDollars: number | null;
  ctr: number | null;
  cpm: number | null;
  cpc: number | null;
  conversionRate: number | null;
  addToCartRate: number | null;
  checkoutRate: number | null;
}

export interface LtvAdjustedMetrics {
  rawRoas: number | null;
  ltvAdjustedRoas: number | null;
  profitableWithLtv: boolean;
}

function centsToDollars(cents: number): number {
  return cents / 100;
}

function safeDiv(
  numerator: number,
  denominator: number
): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function computeMetrics(row: InsightRow): DerivedMetrics {
  const spendDollars = centsToDollars(row.spendCents);
  const revenueDollars = centsToDollars(row.purchaseValueCents);

  return {
    spendDollars,
    revenueDollars,
    roas: safeDiv(revenueDollars, spendDollars),
    costPerPurchaseDollars: safeDiv(spendDollars, row.purchases),
    ctr: safeDiv(row.clicks, row.impressions) !== null
      ? (row.clicks / row.impressions) * 100
      : null,
    cpm: safeDiv(spendDollars, row.impressions) !== null
      ? (spendDollars / row.impressions) * 1000
      : null,
    cpc: safeDiv(spendDollars, row.clicks),
    conversionRate: safeDiv(row.purchases, row.clicks) !== null
      ? (row.purchases / row.clicks) * 100
      : null,
    addToCartRate: safeDiv(row.addToCart, row.clicks) !== null
      ? (row.addToCart / row.clicks) * 100
      : null,
    checkoutRate: safeDiv(row.initiateCheckout, row.addToCart) !== null
      ? (row.initiateCheckout / row.addToCart) * 100
      : null,
  };
}

export function aggregateAndCompute(rows: InsightRow[]): DerivedMetrics {
  if (rows.length === 0) {
    return computeMetrics({
      spendCents: 0,
      impressions: 0,
      clicks: 0,
      reach: 0,
      purchases: 0,
      purchaseValueCents: 0,
      addToCart: 0,
      initiateCheckout: 0,
    });
  }

  const totals: InsightRow = {
    spendCents: 0,
    impressions: 0,
    clicks: 0,
    reach: 0,
    purchases: 0,
    purchaseValueCents: 0,
    addToCart: 0,
    initiateCheckout: 0,
  };

  for (const row of rows) {
    totals.spendCents += row.spendCents;
    totals.impressions += row.impressions;
    totals.clicks += row.clicks;
    totals.reach += row.reach;
    totals.purchases += row.purchases;
    totals.purchaseValueCents += row.purchaseValueCents;
    totals.addToCart += row.addToCart;
    totals.initiateCheckout += row.initiateCheckout;
  }

  return computeMetrics(totals);
}

export function computeLtvAdjustedRoas(
  spendCents: number,
  purchaseValueCents: number,
  subscriptionPurchases: number,
  monthlySubscriptionCents: number,
  avgRetentionMonths: number
): LtvAdjustedMetrics {
  const spendDollars = centsToDollars(spendCents);
  const immediateValueDollars = centsToDollars(purchaseValueCents);

  if (spendDollars === 0) {
    return {
      rawRoas: null,
      ltvAdjustedRoas: null,
      profitableWithLtv: false,
    };
  }

  const rawRoas = immediateValueDollars / spendDollars;

  const subscriptionLtvDollars =
    centsToDollars(monthlySubscriptionCents) * avgRetentionMonths;
  const totalLtvDollars =
    immediateValueDollars + subscriptionPurchases * subscriptionLtvDollars;
  const ltvAdjustedRoas = totalLtvDollars / spendDollars;

  return {
    rawRoas,
    ltvAdjustedRoas,
    profitableWithLtv: ltvAdjustedRoas >= 1.0,
  };
}
