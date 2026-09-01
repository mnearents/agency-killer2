/**
 * Sales velocity — turns raw stock counts into days of cover.
 *
 * "12 units left" is not actionable. "12 units left, selling 4/day, 3 days
 * of cover" is. Every inventory decision downstream keys off days of cover.
 */

/** Units sold per day over the observation window. */
export function computeDailyVelocity(unitsSold: number, windowDays: number): number {
  if (windowDays <= 0) return 0;
  return unitsSold / windowDays;
}

/**
 * Days until stock runs out at the current rate.
 * Returns null when nothing is selling — cover is effectively infinite,
 * which is a different condition from "runs out today".
 */
export function computeDaysOfCover(
  quantity: number,
  dailyVelocity: number
): number | null {
  if (dailyVelocity <= 0) return null;
  if (quantity <= 0) return 0;
  return quantity / dailyVelocity;
}
