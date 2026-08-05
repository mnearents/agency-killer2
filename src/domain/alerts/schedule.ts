/**
 * Alert scheduling — controls when and how often alerts are sent.
 * Respects work hours so nobody gets pinged at midnight.
 */

export interface WorkHours {
  startHourUtc: number; // e.g., 15 = 8 AM PT
  endHourUtc: number;   // e.g., 1 = 6 PM PT (next day)
}

// Default: 8 AM – 6 PM Pacific (UTC-7)
export const DEFAULT_WORK_HOURS: WorkHours = {
  startHourUtc: 15, // 8 AM PT
  endHourUtc: 1,    // 6 PM PT (next UTC day)
};

export const MAX_ALERTS_PER_RUN = 3;

/**
 * Check if the current time is within work hours.
 * Handles overnight UTC ranges (e.g., 15:00–01:00 UTC = 8AM–6PM PT).
 */
export function isDuringWorkHours(now: Date, hours: WorkHours = DEFAULT_WORK_HOURS): boolean {
  const currentHour = now.getUTCHours();

  if (hours.startHourUtc < hours.endHourUtc) {
    // Same-day range (e.g., 9–17)
    return currentHour >= hours.startHourUtc && currentHour < hours.endHourUtc;
  }

  // Overnight range (e.g., 15–1 = 8AM PT to 6PM PT)
  return currentHour >= hours.startHourUtc || currentHour < hours.endHourUtc;
}

import type { Alert } from "./checks";

/**
 * Prioritize and cap alerts. Most severe first, limited to MAX_ALERTS_PER_RUN.
 */
export function prioritizeAlerts(
  alerts: Alert[],
  max = MAX_ALERTS_PER_RUN
): Alert[] {
  const severityOrder: Record<string, number> = { urgent: 0, warning: 1, info: 2 };

  return [...alerts]
    .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3))
    .slice(0, max);
}
