/**
 * Subscription analytics over the Seal tables — pure functions, no DB.
 *
 * This replaces the price-inference LTV module, which was wrong in three ways
 * that all pushed the same direction (making the business look worse and
 * younger than it is):
 *
 *  1. It guessed tier from the order total. Proration makes price a noisy
 *     signal — legitimate charges land at $6.88 and $48 — so tiers were
 *     mislabelled. Tier and cohort now come from `variant_id` via the sync.
 *  2. It guessed churn from "no order in 45 days". Seal records `status` and
 *     `cancelled_on` directly, so churn is now read, not inferred.
 *  3. It averaged tenure across active and churned subscribers together. That
 *     is right-censoring: an active subscriber's run is unfinished, so mixing
 *     them in drags measured tenure toward zero. The two cohorts are now never
 *     blended.
 *
 * A fourth problem is inherent to the data rather than the old code, and is
 * handled by splitting rather than hiding. `order_placed` is the Color Happy →
 * RAD migration timestamp for the bulk-imported records, not the date the
 * customer actually subscribed. Their true tenure is unknowable from this
 * table, so their measured tenure is a FLOOR and is reported apart from
 * subscribers whose real start date is known.
 */

export interface SubscriptionFact {
  id: string;
  status: string;
  tier: string;
  pricingCohort: string;
  /** Raw Seal string: "1 month", "12 month", "13 month". */
  billingInterval: string;
  /** Normalised: monthly, annual, other. */
  billingCadence: string;
  priceCents: number | null;
  priceAnomaly: boolean;
  inDunning: boolean;
  /** True when the record came from the bulk migration, so orderPlaced is not a signup date. */
  manualOrigin: boolean;
  orderPlaced: Date | null;
  cancelledOn: Date | null;
}

export interface SnapshotFact {
  snapshotDate: string;
  subscriptionId: string;
  tier: string;
  pricingCohort: string;
  status: string;
}

const ACTIVE = "ACTIVE";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 365.25 / 12;

function monthsBetween(start: Date, end: Date): number {
  return (end.getTime() - start.getTime()) / MS_PER_DAY / DAYS_PER_MONTH;
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Annual plans contribute a twelfth of their charge, never the whole thing. */
function monthlyContributionCents(f: SubscriptionFact): number {
  const price = f.priceCents ?? 0;
  return f.billingCadence === "annual" ? Math.round(price / 12) : price;
}

// ─── subscription_summary ──────────────────────────────────────────────

export interface SummaryGroup {
  tier: string;
  pricingCohort: string;
  billingCadence: string;
  subscribers: number;
  mrrCents: number;
}

export interface SubscriptionSummary {
  activeTotal: number;
  byTier: Record<string, number>;
  byPricingCohort: Record<string, number>;
  byBillingInterval: Record<string, number>;
  byGroup: SummaryGroup[];
  mrr: {
    monthlyBilledCents: number;
    annualAmortisedCents: number;
    totalCents: number;
  };
  arrCents: number;
  dunning: number;
  excluded: {
    priceAnomalies: number;
    anomalousTotalCents: number;
    missingPrice: number;
  };
}

export function summariseActive(facts: SubscriptionFact[]): SubscriptionSummary {
  const active = facts.filter((f) => f.status === ACTIVE);

  let monthlyBilledCents = 0;
  let annualAmortisedCents = 0;
  let priceAnomalies = 0;
  let anomalousTotalCents = 0;
  let missingPrice = 0;

  const groups = new Map<string, SummaryGroup>();

  for (const f of active) {
    // Counted in the breakdowns but kept out of money. A $19,382 "subscription"
    // is a data fault, and folding it into MRR would hide it.
    if (f.priceAnomaly) {
      priceAnomalies++;
      anomalousTotalCents += f.priceCents ?? 0;
    } else if (f.priceCents === null) {
      missingPrice++;
    } else {
      const contribution = monthlyContributionCents(f);
      if (f.billingCadence === "annual") annualAmortisedCents += contribution;
      else monthlyBilledCents += contribution;

      const key = `${f.tier}|${f.pricingCohort}|${f.billingCadence}`;
      const existing = groups.get(key);
      if (existing) {
        existing.subscribers++;
        existing.mrrCents += contribution;
      } else {
        groups.set(key, {
          tier: f.tier,
          pricingCohort: f.pricingCohort,
          billingCadence: f.billingCadence,
          subscribers: 1,
          mrrCents: contribution,
        });
      }
    }
  }

  const totalCents = monthlyBilledCents + annualAmortisedCents;

  return {
    activeTotal: active.length,
    byTier: tally(active.map((f) => f.tier)),
    byPricingCohort: tally(active.map((f) => f.pricingCohort)),
    byBillingInterval: tally(active.map((f) => f.billingInterval)),
    byGroup: [...groups.values()].sort((a, b) => b.mrrCents - a.mrrCents),
    mrr: { monthlyBilledCents, annualAmortisedCents, totalCents },
    arrCents: totalCents * 12,
    dunning: active.filter((f) => f.inDunning).length,
    excluded: { priceAnomalies, anomalousTotalCents, missingPrice },
  };
}

// ─── subscription_ltv ──────────────────────────────────────────────────

export interface LtvGroup {
  tier: string;
  pricingCohort: string;
  billingCadence: string;
  subscribers: number;
  avgTenureMonths: number | null;
  medianTenureMonths: number | null;
  avgLtvCents: number | null;
  totalLtvCents: number;
}

export interface LtvBlock {
  subscribers: number;
  /** True when orderPlaced is a migration timestamp, so tenure is a lower bound. */
  tenureIsFloor: boolean;
  avgTenureMonths: number | null;
  medianTenureMonths: number | null;
  avgLtvCents: number | null;
  totalLtvCents: number;
  byGroup: LtvGroup[];
}

export interface LtvCohort {
  /** Churned runs are finished; active ones are not. */
  complete: boolean;
  observed: LtvBlock;
  migrated: LtvBlock;
}

export interface LtvResult {
  churned: LtvCohort;
  active: LtvCohort;
  excluded: {
    priceAnomalies: number;
    missingPrice: number;
    missingStartDate: number;
    invalidDates: number;
  };
}

interface Measured {
  fact: SubscriptionFact;
  tenureMonths: number;
  ltvCents: number;
}

/**
 * Revenue actually collected is not in the database — invoices are not synced —
 * so this is elapsed billing periods times the current price. It is an estimate,
 * and the tool description says so. A price change mid-run is not reflected.
 */
function estimateLtvCents(f: SubscriptionFact, tenureMonths: number): number {
  const price = f.priceCents ?? 0;
  if (f.billingCadence === "annual") {
    // The signup charge plus one per completed year.
    return price * (1 + Math.floor(tenureMonths / 12));
  }
  return price * Math.max(1, Math.floor(tenureMonths) + 1);
}

function buildBlock(measured: Measured[], tenureIsFloor: boolean): LtvBlock {
  const groups = new Map<string, Measured[]>();
  for (const m of measured) {
    const key = `${m.fact.tier}|${m.fact.pricingCohort}|${m.fact.billingCadence}`;
    const list = groups.get(key);
    if (list) list.push(m);
    else groups.set(key, [m]);
  }

  const byGroup: LtvGroup[] = [...groups.values()]
    .map((list) => ({
      tier: list[0].fact.tier,
      pricingCohort: list[0].fact.pricingCohort,
      billingCadence: list[0].fact.billingCadence,
      subscribers: list.length,
      avgTenureMonths: mean(list.map((m) => m.tenureMonths)),
      medianTenureMonths: median(list.map((m) => m.tenureMonths)),
      avgLtvCents: mean(list.map((m) => m.ltvCents)),
      totalLtvCents: list.reduce((s, m) => s + m.ltvCents, 0),
    }))
    .sort((a, b) => b.subscribers - a.subscribers);

  return {
    subscribers: measured.length,
    tenureIsFloor,
    avgTenureMonths: mean(measured.map((m) => m.tenureMonths)),
    medianTenureMonths: median(measured.map((m) => m.tenureMonths)),
    avgLtvCents: mean(measured.map((m) => m.ltvCents)),
    totalLtvCents: measured.reduce((s, m) => s + m.ltvCents, 0),
    byGroup,
  };
}

export function computeLtv(facts: SubscriptionFact[], now: Date): LtvResult {
  const churnedObserved: Measured[] = [];
  const churnedMigrated: Measured[] = [];
  const activeObserved: Measured[] = [];
  const activeMigrated: Measured[] = [];

  let priceAnomalies = 0;
  let missingPrice = 0;
  let missingStartDate = 0;
  let invalidDates = 0;

  for (const f of facts) {
    if (f.priceAnomaly) {
      priceAnomalies++;
      continue;
    }
    if (f.priceCents === null) {
      missingPrice++;
      continue;
    }
    if (!f.orderPlaced) {
      missingStartDate++;
      continue;
    }

    const isChurned = f.status !== ACTIVE;
    const endedAt = isChurned ? f.cancelledOn : now;
    if (!endedAt) {
      // Cancelled with no cancellation date: cannot be measured either way.
      invalidDates++;
      continue;
    }

    const tenureMonths = monthsBetween(f.orderPlaced, endedAt);
    // Negative tenure means the dates are corrupt. Averaging it in would pull
    // the cohort mean down with a number that cannot be true.
    if (tenureMonths < 0) {
      invalidDates++;
      continue;
    }

    const measured: Measured = { fact: f, tenureMonths, ltvCents: estimateLtvCents(f, tenureMonths) };
    if (isChurned) (f.manualOrigin ? churnedMigrated : churnedObserved).push(measured);
    else (f.manualOrigin ? activeMigrated : activeObserved).push(measured);
  }

  return {
    churned: {
      complete: true,
      observed: buildBlock(churnedObserved, false),
      migrated: buildBlock(churnedMigrated, true),
    },
    active: {
      complete: false,
      observed: buildBlock(activeObserved, false),
      migrated: buildBlock(activeMigrated, true),
    },
    excluded: { priceAnomalies, missingPrice, missingStartDate, invalidDates },
  };
}

// ─── subscription_changes ──────────────────────────────────────────────

export type Granularity = "day" | "week" | "month";

export interface ChangesInput {
  facts: SubscriptionFact[];
  snapshots: SnapshotFact[];
  start: Date;
  end: Date;
  granularity?: Granularity;
}

export interface TransitionPath {
  from: string;
  to: string;
  subscribers: number;
}

export type TierTransitions =
  | {
      available: false;
      reason: string;
      snapshotDatesInRange: string[];
    }
  | {
      available: true;
      source: string;
      comparedFrom: string;
      comparedTo: string;
      /** False when the snapshots compared do not reach the ends of the requested range. */
      coversRequestedRange: boolean;
      /** Set whenever coversRequestedRange is false, naming the gap. */
      caveat: string | null;
      comparedSubscriptions: number;
      upgraded: number;
      downgraded: number;
      /** The movement Matt tracks weekly: grandfathered Spark → grandfathered Studio. */
      grandfatheredSparkToStudio: number;
      byPath: TransitionPath[];
    };

export interface SeriesPoint {
  periodStart: string;
  new: number;
  cancelled: number;
  net: number;
}

export interface ChangesResult {
  newSubscriptions: {
    total: number;
    byTier: Record<string, number>;
    byPricingCohort: Record<string, number>;
    excludedMigrated: number;
    source: string;
  };
  cancellations: {
    total: number;
    byTier: Record<string, number>;
    byPricingCohort: Record<string, number>;
    source: string;
  };
  netChange: number;
  tierTransitions: TierTransitions;
  series: SeriesPoint[] | null;
}

const TIER_RANK: Record<string, number> = { spark: 1, studio: 2 };

function inRange(d: Date | null, start: Date, end: Date): boolean {
  return d !== null && d >= start && d <= end;
}

function periodKey(d: Date, granularity: Granularity): string {
  const iso = d.toISOString().slice(0, 10);
  if (granularity === "day") return iso;
  if (granularity === "month") return `${iso.slice(0, 7)}-01`;
  // Week starts Monday, so a weekly number lines up with a working week.
  const copy = new Date(`${iso}T00:00:00.000Z`);
  const dow = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - dow);
  return copy.toISOString().slice(0, 10);
}

function buildSeries(
  news: SubscriptionFact[],
  cancels: SubscriptionFact[],
  start: Date,
  end: Date,
  granularity: Granularity
): SeriesPoint[] {
  const points = new Map<string, SeriesPoint>();
  // Seeded across the whole window so a period with no movement shows as zero
  // rather than disappearing from the series.
  const cursor = new Date(`${periodKey(start, granularity)}T00:00:00.000Z`);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    points.set(key, { periodStart: key, new: 0, cancelled: 0, net: 0 });
    if (granularity === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (granularity === "week") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  for (const f of news) {
    const p = points.get(periodKey(f.orderPlaced!, granularity));
    if (p) p.new++;
  }
  for (const f of cancels) {
    const p = points.get(periodKey(f.cancelledOn!, granularity));
    if (p) p.cancelled++;
  }
  for (const p of points.values()) p.net = p.new - p.cancelled;

  return [...points.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

function computeTransitions(
  snapshots: SnapshotFact[],
  start: Date,
  end: Date
): TierTransitions {
  const startDay = start.toISOString().slice(0, 10);
  const endDay = end.toISOString().slice(0, 10);
  const inWindow = snapshots.filter((s) => s.snapshotDate >= startDay && s.snapshotDate <= endDay);
  const dates = [...new Set(inWindow.map((s) => s.snapshotDate))].sort();

  // Fewer than two snapshot days means there is nothing to compare. Returning
  // "0 upgrades" here would be indistinguishable from "we looked and nobody
  // upgraded", which is the failure this whole rewrite exists to avoid.
  if (dates.length < 2) {
    return {
      available: false,
      reason:
        `Tier transitions need at least two snapshot days inside the range; found ${dates.length}. ` +
        `Daily snapshots began 2026-09-02, so any window before then cannot be measured. ` +
        `Upgrades that happened earlier are not recoverable from this data.`,
      snapshotDatesInRange: dates,
    };
  }

  const first = dates[0];
  const last = dates[dates.length - 1];
  const before = new Map(inWindow.filter((s) => s.snapshotDate === first).map((s) => [s.subscriptionId, s]));
  const after = new Map(inWindow.filter((s) => s.snapshotDate === last).map((s) => [s.subscriptionId, s]));

  let upgraded = 0;
  let downgraded = 0;
  let grandfatheredSparkToStudio = 0;
  let comparedSubscriptions = 0;
  const paths = new Map<string, TransitionPath>();

  for (const [id, from] of before) {
    const to = after.get(id);
    // Present at both ends only; a subscription that appeared or vanished is a
    // new/cancelled event, not a tier move.
    if (!to) continue;
    comparedSubscriptions++;
    if (from.tier === to.tier) continue;

    const fromRank = TIER_RANK[from.tier];
    const toRank = TIER_RANK[to.tier];
    if (fromRank === undefined || toRank === undefined) continue;

    if (toRank > fromRank) {
      upgraded++;
      if (
        from.tier === "spark" &&
        to.tier === "studio" &&
        from.pricingCohort === "grandfathered" &&
        to.pricingCohort === "grandfathered"
      ) {
        grandfatheredSparkToStudio++;
      }
    } else {
      downgraded++;
    }

    const key = `${from.tier}/${from.pricingCohort} -> ${to.tier}/${to.pricingCohort}`;
    const existing = paths.get(key);
    if (existing) existing.subscribers++;
    else
      paths.set(key, {
        from: `${from.tier}/${from.pricingCohort}`,
        to: `${to.tier}/${to.pricingCohort}`,
        subscribers: 1,
      });
  }

  // Snapshots may only cover a sliver of the window asked for. Saying so is
  // the difference between "nobody upgraded in Q3" and "we can see one day".
  const coversRequestedRange = first <= startDay && last >= endDay;
  const caveat = coversRequestedRange
    ? null
    : `Requested ${startDay} to ${endDay}, but snapshots only allow a comparison from ${first} to ${last}. ` +
      `Movement outside that window is not counted here.`;

  return {
    available: true,
    source: "seal_subscription_snapshots, comparing the first and last snapshot day in range",
    comparedFrom: first,
    comparedTo: last,
    coversRequestedRange,
    caveat,
    comparedSubscriptions,
    upgraded,
    downgraded,
    grandfatheredSparkToStudio,
    byPath: [...paths.values()].sort((a, b) => b.subscribers - a.subscribers),
  };
}

export function computeChanges(input: ChangesInput): ChangesResult {
  const { facts, snapshots, start, end, granularity } = input;

  const newInRange = facts.filter((f) => inRange(f.orderPlaced, start, end));
  // The migration wrote its own import timestamp into order_placed for ~4,000
  // records. Those are not signups and must never be counted as growth.
  const news = newInRange.filter((f) => !f.manualOrigin);
  const excludedMigrated = newInRange.length - news.length;

  const cancels = facts.filter((f) => inRange(f.cancelledOn, start, end));

  return {
    newSubscriptions: {
      total: news.length,
      byTier: tally(news.map((f) => f.tier)),
      byPricingCohort: tally(news.map((f) => f.pricingCohort)),
      excludedMigrated,
      source:
        "seal_subscriptions.order_placed, excluding manual_origin rows whose order_placed is a bulk-migration timestamp",
    },
    cancellations: {
      total: cancels.length,
      byTier: tally(cancels.map((f) => f.tier)),
      byPricingCohort: tally(cancels.map((f) => f.pricingCohort)),
      source: "seal_subscriptions.cancelled_on",
    },
    netChange: news.length - cancels.length,
    tierTransitions: computeTransitions(snapshots, start, end),
    series: granularity ? buildSeries(news, cancels, start, end, granularity) : null,
  };
}
