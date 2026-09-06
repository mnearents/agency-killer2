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

import { expectedPriceCents } from "./sync-transform";

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
  /** Tier moves read from Seal's log — the primary source for transitions. */
  tierChanges: TierChangeFact[];
  start: Date;
  end: Date;
  granularity?: Granularity;
}

export interface TransitionPath {
  from: string;
  to: string;
  subscribers: number;
}

/** One tier move, as read out of Seal's log by parseTierHistory. */
export interface TierChangeFact {
  subscriptionId: string;
  /** ISO timestamp. Seal stamps its log in UTC. */
  at: string;
  from: string;
  to: string;
  /** The subscription's cohort today — the log does not record cohort. */
  pricingCohort: string;
}

/** A subscription billing something other than its plan's grid price. */
export interface MispricedSubscription {
  subscriptionId: string;
  tier: string;
  pricingCohort: string;
  billingInterval: string;
  priceDollars: number;
  expectedDollars: number;
}

/** Snapshot agreement, for corroboration only. */
export type SnapshotCheck =
  | { compared: false }
  | { compared: true; from: string; to: string; upgraded: number; downgraded: number };

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
      /** False when the window reaches back before Seal's log begins. */
      coversRequestedRange: boolean;
      /** Set whenever coversRequestedRange is false, naming the gap. */
      caveat: string | null;
      comparedSubscriptions: number;
      /** Raw number of tier moves, which can exceed the subscriptions that moved. */
      transitions: number;
      /** Subscriptions that moved more than once in the window. */
      churnedSubscriptions: number;
      upgraded: number;
      downgraded: number;
      /** The movement Matt tracks weekly: grandfathered Spark → grandfathered Studio. */
      grandfatheredSparkToStudio: number;
      /**
       * Subscriptions that moved tier in the window and are still not on the
       * grid price for the tier they now sit on. Live billing bugs.
       */
      mispricedAfterChange: MispricedSubscription[];
      byPath: TransitionPath[];
      snapshotCheck: SnapshotCheck;
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

/**
 * Seal's per-subscription log does not reach back before this. Every entry
 * across 4,395 subscriptions falls on or after it, and no subscription's
 * order_placed predates 2026-05, so this is where the shop's history starts
 * rather than a retention cliff — confirmed by 542 cancellations whose
 * cancelled_on field all have a matching log entry, in every month.
 */
export const LOG_COVERAGE_START = "2026-05-22";

/** Net movement of one subscription across the window, and how noisy it was. */
function netPerSubscription(changes: TierChangeFact[]) {
  const bySub = new Map<string, TierChangeFact[]>();
  for (const c of changes) {
    const list = bySub.get(c.subscriptionId);
    if (list) list.push(c);
    else bySub.set(c.subscriptionId, [c]);
  }

  let upgraded = 0;
  let downgraded = 0;
  let churned = 0;
  const paths = new Map<string, TransitionPath>();

  for (const list of bySub.values()) {
    const ordered = [...list].sort((a, b) => a.at.localeCompare(b.at));
    if (ordered.length > 1) churned++;

    const from = ordered[0].from;
    const to = ordered[ordered.length - 1].to;
    const fromRank = TIER_RANK[from];
    const toRank = TIER_RANK[to];
    // A tier we could not name is not evidence of movement in either
    // direction; counting it would invent an upgrade we never saw.
    if (fromRank === undefined || toRank === undefined || fromRank === toRank) continue;

    if (toRank > fromRank) upgraded++;
    else downgraded++;

    // Cohort is the subscription's cohort today. A cohort change would be
    // invisible here, which is why the source string says so.
    const cohort = ordered[ordered.length - 1].pricingCohort;
    const key = `${from}/${cohort} -> ${to}/${cohort}`;
    const existing = paths.get(key);
    if (existing) existing.subscribers++;
    else paths.set(key, { from: `${from}/${cohort}`, to: `${to}/${cohort}`, subscribers: 1 });
  }

  return { upgraded, downgraded, churned, paths, subscriptions: bySub.size };
}

/**
 * Compare the first and last snapshot day in the window. This is corroboration
 * only: a snapshot is a daily photograph, so a change made after the day's
 * snapshot was written is invisible to it. Disagreement with the log is
 * expected and is not an error.
 */
function snapshotCheck(snapshots: SnapshotFact[], startDay: string, endDay: string): SnapshotCheck {
  const inWindow = snapshots.filter((s) => s.snapshotDate >= startDay && s.snapshotDate <= endDay);
  const dates = [...new Set(inWindow.map((s) => s.snapshotDate))].sort();
  if (dates.length < 2) return { compared: false };

  const first = dates[0];
  const last = dates[dates.length - 1];
  const before = new Map(inWindow.filter((s) => s.snapshotDate === first).map((s) => [s.subscriptionId, s]));
  const after = new Map(inWindow.filter((s) => s.snapshotDate === last).map((s) => [s.subscriptionId, s]));

  let upgraded = 0;
  let downgraded = 0;
  for (const [id, from] of before) {
    const to = after.get(id);
    if (!to || to.tier === from.tier) continue;
    const fromRank = TIER_RANK[from.tier];
    const toRank = TIER_RANK[to.tier];
    if (fromRank === undefined || toRank === undefined) continue;
    if (toRank > fromRank) upgraded++;
    else downgraded++;
  }
  return { compared: true, from: first, to: last, upgraded, downgraded };
}

/**
 * Of the subscriptions that moved, which are still billing the wrong amount.
 *
 * Seal writes no price entry to the log when the price follows the variant, so
 * `priceChangeLogged` is false on every tier change ever recorded and cannot
 * discriminate. The subscription's price today against the grid for the tier it
 * now sits on can.
 */
function mispricedAmong(moved: Set<string>, facts: SubscriptionFact[]): MispricedSubscription[] {
  const out: MispricedSubscription[] = [];
  for (const f of facts) {
    if (!moved.has(f.id)) continue;
    // A cancelled subscriber is not being billed, so a stale price on one is
    // not a live bug and would only bury the ones that are.
    if (f.status !== "ACTIVE") continue;
    if (f.priceCents === null) continue;
    const expected = expectedPriceCents(f.tier, f.pricingCohort, f.billingInterval);
    // No grid entry means no expected price to compare against. Reporting that
    // as mispriced would be a finding we have no evidence for.
    if (expected === null || f.priceCents === expected) continue;
    out.push({
      subscriptionId: f.id,
      tier: f.tier,
      pricingCohort: f.pricingCohort,
      billingInterval: f.billingInterval,
      priceDollars: f.priceCents / 100,
      expectedDollars: expected / 100,
    });
  }
  return out;
}

export function computeTransitions(
  changes: TierChangeFact[],
  snapshots: SnapshotFact[],
  facts: SubscriptionFact[],
  start: Date,
  end: Date
): TierTransitions {
  const startDay = start.toISOString().slice(0, 10);
  const endDay = end.toISOString().slice(0, 10);

  // A window that closes before Seal started logging is unanswerable. Zero
  // here would be indistinguishable from "we looked and nobody upgraded",
  // which is the failure this whole path exists to avoid.
  if (endDay < LOG_COVERAGE_START) {
    return {
      available: false,
      reason:
        `Tier changes are read from Seal's subscription log, which begins ${LOG_COVERAGE_START}. ` +
        `The requested window ends ${endDay}, entirely before that, so no movement can be seen. ` +
        `This is not a count of zero.`,
      snapshotDatesInRange: [...new Set(snapshots.filter((s) => s.snapshotDate >= startDay && s.snapshotDate <= endDay).map((s) => s.snapshotDate))].sort(),
    };
  }

  const inWindow = changes.filter((c) => {
    const day = c.at.slice(0, 10);
    return day >= startDay && day <= endDay;
  });

  const net = netPerSubscription(inWindow);
  const coversRequestedRange = startDay >= LOG_COVERAGE_START;

  return {
    available: true,
    source:
      "seal_subscriptions.log, folded into tier changes per subscription. " +
      "Pricing cohort is the subscription's cohort today, not at the time of the change.",
    comparedFrom: coversRequestedRange ? startDay : LOG_COVERAGE_START,
    comparedTo: endDay,
    coversRequestedRange,
    caveat: coversRequestedRange
      ? null
      : `Requested from ${startDay}, but Seal's log begins ${LOG_COVERAGE_START}. ` +
        `Any tier change before that is not visible, so these counts are a floor.`,
    comparedSubscriptions: net.subscriptions,
    transitions: inWindow.length,
    churnedSubscriptions: net.churned,
    upgraded: net.upgraded,
    downgraded: net.downgraded,
    grandfatheredSparkToStudio: [...net.paths.values()]
      .filter((p) => p.from === "spark/grandfathered" && p.to === "studio/grandfathered")
      .reduce((n, p) => n + p.subscribers, 0),
    mispricedAfterChange: mispricedAmong(new Set(inWindow.map((c) => c.subscriptionId)), facts),
    byPath: [...net.paths.values()].sort((a, b) => b.subscribers - a.subscribers),
    snapshotCheck: snapshotCheck(snapshots, startDay, endDay),
  };
}

export function computeChanges(input: ChangesInput): ChangesResult {
  const { facts, snapshots, tierChanges, start, end, granularity } = input;

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
    tierTransitions: computeTransitions(tierChanges, snapshots, facts, start, end),
    series: granularity ? buildSeries(news, cancels, start, end, granularity) : null,
  };
}
