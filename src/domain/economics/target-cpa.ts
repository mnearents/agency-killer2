/**
 * Target CPA — what an acquisition may cost, per business line.
 *
 * #34: "target CPA at break-even and at 3:1 LTV:CAC. For subscriptions use
 * realised churned-cohort LTV from `subscription_ltv`, never the active-cohort
 * figure (censored — active subscribers haven't finished their runs)."
 *
 * ## Break-even CPA is contribution, not revenue
 *
 * Break-even CPA is the contribution margin one acquisition produces: spend
 * exactly that and the customer pays for themselves and nothing else. The 3:1
 * figure is that divided by three. Both are taken over CONTRIBUTION, and the
 * result says so, because the same words over revenue give a number larger by
 * the whole cost of delivery — a $45 planner is a $22.50 break-even CPA at 50%
 * COD, not $45.
 *
 * ## The spec is half right about censoring
 *
 * It is right that the active cohort is censored, and against production the
 * gap is not subtle: active observed reports $53.90 where churned observed
 * reports $23.98.
 *
 * It is wrong that the churned cohort is therefore clean. Seal's observed
 * records begin 2026-05-22, so the whole observation window is under four
 * months, and no finished run inside it can be longer than that. Meanwhile 290
 * observed subscribers are still running with a median tenure of 3.6 months —
 * already at the ceiling of what a finished run could have shown. The churned
 * figure is a floor, and the reason is not bad data: the business has not been
 * on this platform long enough for the question to have a final answer.
 *
 * So both inputs are incomplete, in OPPOSITE directions:
 *
 *   - Fulfilment cost is not in the database. COD is understated, contribution
 *     overstated, and the CPA a CEILING. Spending it loses money.
 *   - The churned cohort is truncated. LTV is understated and the CPA a FLOOR.
 *     Spending it leaves money unspent.
 *
 * A single "estimated" flag over both would tell the reader nothing, so each
 * basis carries a named `bound` and the reasons behind it. When both apply the
 * bound is `indeterminate`: they do not cancel, and neither dominates.
 *
 * Pure functions only — no database, no clock.
 */

import { computeLtv, type SubscriptionFact } from "@/domain/subscriptions/analytics";
import type { UnitEconomicsResult } from "./unit-economics";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 365.25 / 12;

/** The LTV:CAC ratio #34 asks for alongside break-even. */
export const TARGET_LTV_CAC_RATIO = 3;

/**
 * Realised lifetime value of finished, non-migrated subscription runs.
 *
 * `cohort` is a literal rather than a parameter: this type cannot be
 * constructed from the active cohort, and a caller reading the field knows
 * which one it holds without consulting the code that built it.
 */
export interface RealisedLtv {
  cohort: "churned-observed";
  subscribers: number;
  avgLtvCents: number;
  avgTenureMonths: number;
  /** Months from the earliest non-migrated signup on record to now. No finished run can exceed it. */
  observationWindowMonths: number;
  /** Runs from the same window that have not finished. While any exist the figure is a floor. */
  unfinishedRuns: number;
  isFloor: boolean;
}

/**
 * The churned, observed block of `computeLtv` — the only one #34 permits —
 * plus the two facts that say how much to trust it.
 *
 * Returns null when nothing has churned. A zero LTV would set every target CPA
 * in the business to zero and read as an answer.
 */
export function realisedChurnedLtv(facts: SubscriptionFact[], now: Date): RealisedLtv | null {
  const ltv = computeLtv(facts, now);
  const block = ltv.churned.observed;

  if (block.subscribers === 0 || block.avgLtvCents === null) return null;

  // Migrated signups are the June 2026 import timestamp, so including them
  // would shorten the window to the import date and understate it.
  const signups = facts
    .filter((f) => !f.manualOrigin && f.orderPlaced)
    .map((f) => f.orderPlaced!.getTime());
  const earliest = signups.length > 0 ? Math.min(...signups) : now.getTime();
  const observationWindowMonths = (now.getTime() - earliest) / MS_PER_DAY / DAYS_PER_MONTH;

  // Both active blocks: a migrated record is excluded from the FIGURE, but it
  // is still a run that has not finished against this window.
  const unfinishedRuns = ltv.active.observed.subscribers + ltv.active.migrated.subscribers;

  return {
    cohort: "churned-observed",
    subscribers: block.subscribers,
    avgLtvCents: block.avgLtvCents,
    avgTenureMonths: block.avgTenureMonths ?? 0,
    observationWindowMonths,
    unfinishedRuns,
    isFloor: unfinishedRuns > 0,
  };
}

export type CpaValueBasis = "first-order" | "realised-churned-ltv";

/**
 * Which way the figure is wrong.
 *
 * `measured` is not a synonym for "good enough" — it is the claim that nothing
 * known is pulling the number in either direction, and it must be false while
 * anything is.
 */
export type CpaBound = "measured" | "floor" | "ceiling" | "indeterminate";

export interface TargetCpaBasis {
  basis: CpaValueBasis;
  /** What the value per customer actually is, in words. */
  label: string;
  perCustomerRevenueCents: number;
  /** Null at or above 100% cost of delivery — there is no contribution to spend. */
  contributionPerCustomerCents: number | null;
  breakEvenCpaCents: number | null;
  targetCpa3to1Cents: number | null;
  bound: CpaBound;
  boundReasons: string[];
  /** Subscribers behind a cohort figure; null when the basis is not cohort-derived. */
  cohortSize: number | null;
  caveats: string[];
}

export interface TargetCpaResult {
  businessLine: string;
  codPct: number | null;
  /** Named so nobody has to guess whether 3:1 was taken over revenue. */
  ratioBasis: "contribution";
  bases: TargetCpaBasis[];
  recommendedBasis: CpaValueBasis | null;
  /** Reasons a basis is absent or a CPA is null. Empty means nothing was withheld. */
  blockers: string[];
}

export interface TargetCpaInput {
  businessLine: string;
  economics: UnitEconomicsResult;
  /** Subscriptions only. Ignored, loudly, on any other line. */
  ltv?: RealisedLtv | null;
}

const SUBSCRIPTION = "subscription";

function boundFrom(reasons: { floor: string[]; ceiling: string[] }): {
  bound: CpaBound;
  boundReasons: string[];
} {
  const boundReasons = [...reasons.ceiling, ...reasons.floor];
  if (reasons.floor.length > 0 && reasons.ceiling.length > 0)
    return { bound: "indeterminate", boundReasons };
  if (reasons.ceiling.length > 0) return { bound: "ceiling", boundReasons };
  if (reasons.floor.length > 0) return { bound: "floor", boundReasons };
  return { bound: "measured", boundReasons: [] };
}

export function computeTargetCpa(input: TargetCpaInput): TargetCpaResult {
  const { businessLine, economics } = input;
  const blockers: string[] = [];
  const isSubscription = businessLine === SUBSCRIPTION;

  if (economics.orders === 0 || economics.codPct === null) {
    return {
      businessLine,
      codPct: economics.codPct,
      ratioBasis: "contribution",
      bases: [],
      recommendedBasis: null,
      blockers: [
        "No orders in this window, so there is no cost of delivery to compute a CPA against.",
      ],
    };
  }

  const codPct = economics.codPct;
  const marginRate = 1 - codPct;
  const coversCost = marginRate > 0;

  if (!coversCost) {
    blockers.push(
      `Cost of delivery is ${(100 * codPct).toFixed(1)}% of revenue, so there is no contribution ` +
        `to spend on acquisition and no CPA breaks even. Every figure below is null by that fact, ` +
        `not by a missing input.`
    );
  }

  // The cost side is understated while any component is missing, which makes
  // every CPA built on it too generous.
  const costCeiling = economics.complete
    ? []
    : [
        `Cost of delivery is missing ${economics.missing.join(", ")}, so contribution is ` +
          `overstated and this CPA is a ceiling.`,
      ];

  const build = (
    basis: CpaValueBasis,
    label: string,
    perCustomerRevenueCents: number,
    extra: { floor: string[]; cohortSize: number | null; caveats: string[] }
  ): TargetCpaBasis => {
    const contribution = coversCost
      ? Math.round(perCustomerRevenueCents * marginRate)
      : null;
    const { bound, boundReasons } = boundFrom({ floor: extra.floor, ceiling: costCeiling });
    return {
      basis,
      label,
      perCustomerRevenueCents,
      contributionPerCustomerCents: contribution,
      breakEvenCpaCents: contribution,
      targetCpa3to1Cents:
        contribution === null ? null : Math.round(contribution / TARGET_LTV_CAC_RATIO),
      bound,
      boundReasons,
      cohortSize: extra.cohortSize,
      caveats: extra.caveats,
    };
  };

  const bases: TargetCpaBasis[] = [
    build("first-order", "Contribution on one order at the average order value", economics.aovCents, {
      floor: [],
      cohortSize: null,
      caveats: [
        isSubscription
          ? "One billing only. A subscription bills repeatedly, so this is the wrong basis for a subscriber budget — it is here to show the gap."
          : "One order only. Repeat purchases are not counted, so a customer who buys again is worth more than this.",
      ],
    }),
  ];

  const ltv = input.ltv ?? null;

  if (ltv && !isSubscription) {
    // The cohort is subscribers. Applying it to a physical buyer would price
    // acquisition off a population that did not buy the thing.
    blockers.push(
      `A subscription LTV was supplied for the ${businessLine} line and was ignored: the cohort ` +
        `behind it is subscribers, not ${businessLine} buyers.`
    );
  }

  if (isSubscription) {
    if (ltv) {
      const floor = ltv.isFloor
        ? [
            `The churned cohort is ${ltv.subscribers} finished runs inside a ` +
              `${ltv.observationWindowMonths.toFixed(1)}-month observation window, with ` +
              `${ltv.unfinishedRuns} still running. No finished run can be longer than the window, ` +
              `so the LTV is understated and this CPA is a floor.`,
          ]
        : [];
      bases.push(
        build(
          "realised-churned-ltv",
          "Contribution over the realised lifetime value of finished, non-migrated subscriptions",
          ltv.avgLtvCents,
          {
            floor,
            cohortSize: ltv.subscribers,
            caveats: [
              `Average tenure ${ltv.avgTenureMonths.toFixed(1)} months. LTV is estimated as elapsed ` +
                `billing periods times current price; collected invoices are not synced.`,
              "The active cohort is excluded by #34: those runs are unfinished and reading them would roughly double this figure.",
            ],
          }
        )
      );
    } else {
      blockers.push(
        "No finished subscription runs are on record, so realised churned-cohort LTV cannot be " +
          "computed and the first-order figure is all there is. It prices a subscriber at one " +
          "billing, which is far below what one is worth."
      );
    }
  }

  const recommendedBasis: CpaValueBasis =
    isSubscription && ltv ? "realised-churned-ltv" : "first-order";

  return {
    businessLine,
    codPct,
    ratioBasis: "contribution",
    bases,
    recommendedBasis,
    blockers,
  };
}
