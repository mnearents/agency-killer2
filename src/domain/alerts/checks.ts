/**
 * Alert checks — pure functions that detect notable conditions
 * from synced data. Each check returns an Alert if triggered, null if not.
 *
 * Design: every check is deterministic and testable. No DB calls —
 * data is pre-fetched and passed in. The runner module handles
 * querying and dispatching.
 */

export interface Alert {
  type: string;
  severity: "info" | "warning" | "urgent";
  message: string;
}

// ─── No email/SMS sends ──────────────────────────────────────────────

export interface EmailSendsInput {
  emailDelivered: number;
  smsDelivered: number;
  hasUpcomingCalendarEntry: boolean;
}

export function checkNoEmailSends(input: EmailSendsInput): Alert | null {
  if (input.emailDelivered > 0 || input.smsDelivered > 0) return null;

  if (input.hasUpcomingCalendarEntry) {
    return null; // Something is planned, don't nag
  }

  return {
    type: "no-sends",
    severity: "warning",
    message:
      "No email or SMS sends in the past 7 days and nothing on the calendar. Add something with `!calendar add` — even a simple freebie drop or behind-the-scenes gives you a reason to send and measure.",
  };
}

// ─── Reel outperforming ───────────────────────────────────────────────

export interface ReelPerformanceInput {
  avgEngagementRate: number | null;
  topPost: {
    caption: string | null;
    engagementRate: number | null;
    saves: number;
    format: string;
    permalink: string | null;
  } | null;
}

export function checkReelOutperforming(input: ReelPerformanceInput): Alert | null {
  if (!input.topPost || !input.avgEngagementRate || !input.topPost.engagementRate) return null;
  if (input.topPost.format !== "Reel") return null;
  if (input.topPost.engagementRate < input.avgEngagementRate * 2) return null;

  const caption = input.topPost.caption
    ? input.topPost.caption.slice(0, 80)
    : "untitled reel";
  const link = input.topPost.permalink ? `\n${input.topPost.permalink}` : "";

  return {
    type: "reel-outperforming",
    severity: "info",
    message:
      `Your reel "${caption}" is at ${input.topPost.engagementRate.toFixed(1)}% engagement (your average is ${input.avgEngagementRate.toFixed(1)}%) with ${input.topPost.saves} saves. This concept is resonating — consider repurposing it as an ad creative or shooting a follow-up.${link}`,
  };
}

// ─── ROAS dropped ─────────────────────────────────────────────────────

export interface RoasInput {
  thisWeekRoas: number | null;
  lastWeekRoas: number | null;
}

export function checkRoasDropped(input: RoasInput): Alert | null {
  if (input.thisWeekRoas == null || input.lastWeekRoas == null) return null;
  if (input.lastWeekRoas <= 0) return null;

  const dropPct = (input.lastWeekRoas - input.thisWeekRoas) / input.lastWeekRoas;
  if (dropPct < 0.4) return null; // Less than 40% drop — not significant

  return {
    type: "roas-drop",
    severity: "warning",
    message:
      `Ad ROAS dropped from ${input.lastWeekRoas.toFixed(2)}x to ${input.thisWeekRoas.toFixed(2)}x (${(dropPct * 100).toFixed(0)}% decline). With Advantage+ this usually means creative fatigue — the winning creatives are getting stale. Time to test new creative concepts.`,
  };
}

// ─── Revenue anomaly ──────────────────────────────────────────────────

export interface RevenueAnomalyInput {
  todayRevenueCents: number;
  trailingAvgRevenueCents: number;
  todayDate: Date;
}

export function checkRevenueAnomaly(input: RevenueAnomalyInput): Alert | null {
  // Skip 1st of month — subscription billing spike is expected
  if (input.todayDate.getUTCDate() === 1) return null;

  if (input.trailingAvgRevenueCents <= 0) return null;

  const ratio = input.todayRevenueCents / input.trailingAvgRevenueCents;

  // Significant drop (less than 40% of average)
  if (ratio < 0.4) {
    return {
      type: "revenue-anomaly",
      severity: "warning",
      message:
        `Today's revenue ($${(input.todayRevenueCents / 100).toFixed(2)}) is significantly below your trailing average ($${(input.trailingAvgRevenueCents / 100).toFixed(2)}). Worth investigating — check if the site is up, ads are running, and there are no checkout issues.`,
    };
  }

  // Significant spike (3x+ average, not 1st of month)
  if (ratio > 3.0) {
    return {
      type: "revenue-anomaly",
      severity: "info",
      message:
        `Revenue spike today: $${(input.todayRevenueCents / 100).toFixed(2)} vs $${(input.trailingAvgRevenueCents / 100).toFixed(2)} average. Nice! Check what drove it — if it's attributable to a specific campaign or post, double down.`,
    };
  }

  return null;
}

// ─── Subscription signups ─────────────────────────────────────────────

export interface SubscriptionSignupsInput {
  newSubscribers: number;
  avgWeeklySubscribers: number;
}

export function checkSubscriptionSignups(input: SubscriptionSignupsInput): Alert | null {
  // No historical baseline — can't evaluate
  if (input.avgWeeklySubscribers <= 0) return null;

  // Zero signups in a week
  if (input.newSubscribers === 0) {
    return {
      type: "sub-drought",
      severity: "warning",
      message:
        `No new Really Awesome Doodles subscriptions this week (average is ${input.avgWeeklySubscribers.toFixed(0)}/week). Check if the subscription offer is visible, ads are pointing to it, and the signup flow is working.`,
    };
  }

  // Surge (3x+ average)
  if (input.newSubscribers >= input.avgWeeklySubscribers * 3) {
    return {
      type: "sub-surge",
      severity: "info",
      message:
        `Subscription surge: ${input.newSubscribers} new RAD subscribers this week vs ${input.avgWeeklySubscribers.toFixed(0)}/week average. Find out what drove it — if it's a specific ad or post, keep it running.`,
    };
  }

  return null;
}
