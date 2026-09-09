/**
 * Dated editions — stock with an expiry date rather than a burn rate.
 *
 * A 2026 planner stops being sellable on 1 January 2027 no matter how well it
 * is selling. Days of cover cannot see this: 617 units selling 25/month reads
 * as two years of cover and classifies healthy, when in fact ~520 of them will
 * be pulped. Cover answers "when do I run out", and for a dated product the
 * question is "how much is left when the clock stops".
 *
 * The signal is a four-digit year in the PRODUCT TITLE. The SKU suffix looks
 * more structured and is not usable: two conventions coexist (`Y26` on
 * planners, a bare `2026` on seventeen other SKUs), the bare form usually
 * records the year a product was introduced rather than an edition, and a
 * Y-prefix rule matches NOTEHAPPY01 and BLKBBY012021 on the Y in HAPPY and
 * BBY. Checked against the full catalogue on 2026-09-08: the title rule has no
 * false positives and misses no dated product.
 *
 * This is deliberately a separate axis from classifyItem rather than another
 * value in its enum. "Will this stock out" and "will this expire" are
 * independent — a dated SKU can be about to sell out, which is good news — and
 * folding them together would make one answer overwrite the other.
 *
 * ASSUMPTION: demand is projected from the trailing TWELVE MONTHS, not the
 * trailing thirty days the rest of this module runs on. Dated products are
 * seasonal by construction — a wall calendar sells almost entirely in Q4 — so a
 * thirty-day window reads whatever month it happens to be run in as if it were
 * December. CALPRNT2026 sold 8 units in the thirty days to 2026-09-08 and 512
 * in the twelve months to the same date; the short window strands 439 units
 * against a 31 December deadline where the long one strands 310. The annual
 * figure is not seasonally correct either, but it averages over exactly one
 * cycle of the seasonality, which is the error this trades away. It does assume
 * next season resembles last season — worth revisiting if the ads-off period
 * turns out to have changed the shape of demand rather than just its level.
 */

import type { InventoryItem } from "./checks";
import { computeDailyVelocity } from "./velocity";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365;

/**
 * The edition year in a product title, or null if the product is undated.
 *
 * Matches 20xx only. Nothing in the catalogue carries a four-digit run that
 * isn't a year, so the restriction costs no coverage today and stops a part
 * number added later from being read as a deadline. The negative lookarounds
 * keep it off a longer run of digits for the same reason.
 */
export function datedEditionYear(productTitle: string): number | null {
  const years = productTitle.match(/(?<![0-9])20[0-9]{2}(?![0-9])/g);
  if (!years) return null;
  // Later year wins, so "2026-2027 Academic Planner" expires at the end of
  // 2027. The other direction declares a year of live stock unsellable.
  return Math.max(...years.map(Number));
}

/**
 * Days of selling left before the edition's year runs out.
 *
 * Zero rather than negative once the year has passed: a negative multiplied
 * through the stranding arithmetic invents sales that unwind stock which is
 * already worthless.
 */
export function daysUntilEditionEnds(editionYear: number, now: Date): number {
  const endsAt = Date.UTC(editionYear + 1, 0, 1);
  return Math.max(0, Math.floor((endsAt - now.getTime()) / MS_PER_DAY));
}

export interface DatedEditionOverhang {
  editionYear: number;
  /** Days until the edition expires. Zero once its year has passed. */
  daysOfSellableLife: number;
  /**
   * Units still on the shelf at the deadline, at the current rate. Null when
   * the projection has no demand evidence to stand on — see below.
   */
  unitsStranded: number | null;
  centsStranded: number | null;
}

/**
 * How much of a dated variant's stock will still be there when it expires.
 *
 * Null for undated products (no deadline to measure against) and for untracked
 * ones. Untracked variants report quantity 0 in Shopify and the digital "2026
 * Pages" packs report it negative; stranding arithmetic on a sentinel returns
 * a confident dollar figure for stock that does not exist.
 *
 * Non-ACTIVE products ARE measured, but only for the deadline — never for the
 * projection. There were 2,449 units of tracked DRAFT and UNLISTED dated stock
 * in production on 2026-09-08 and they expire on the same schedule as the
 * listed ones, so the edition year and remaining life are real facts about
 * them. Their sales are not: a product nobody could buy sold nothing BY
 * CONSTRUCTION, so a zero there is absence of evidence, not evidence of no
 * demand. The first run of this calculation against production reported the
 * two DRAFT 2027 planners as 1,997 units and $50,919 certainly stranded, which
 * is next year's stock read as a write-off. unitsStranded is null in that case
 * rather than a number the reader has no way to distrust.
 *
 * Past the deadline no evidence is needed: whatever is on the shelf is
 * stranded by arithmetic, listed or not.
 */
export function computeDatedOverhang(
  item: InventoryItem,
  now: Date
): DatedEditionOverhang | null {
  if (!item.tracked) return null;

  const editionYear = datedEditionYear(item.productTitle);
  if (editionYear === null) return null;

  const daysOfSellableLife = daysUntilEditionEnds(editionYear, now);
  const unitsStranded = strandedUnits(item, daysOfSellableLife);

  return {
    editionYear,
    daysOfSellableLife,
    unitsStranded,
    centsStranded: unitsStranded === null ? null : unitsStranded * item.priceCents,
  };
}

function strandedUnits(item: InventoryItem, daysOfSellableLife: number): number | null {
  // The deadline has passed. Everything left is stranded, and no sales history
  // is needed to say so.
  if (daysOfSellableLife === 0) return Math.max(0, item.quantity);

  // Not on sale during the observation window, so its zero sales say nothing
  // about demand and cannot be projected across the life remaining.
  if (item.productStatus !== "ACTIVE") return null;

  const dailyVelocity = computeDailyVelocity(item.unitsSoldLast12m, DAYS_PER_YEAR);
  return Math.max(0, Math.round(item.quantity - dailyVelocity * daysOfSellableLife));
}
