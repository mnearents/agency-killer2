import { describe, it, expect } from "vitest";
import {
  checkNoEmailSends,
  checkReelOutperforming,
  checkRoasDropped,
  checkRevenueAnomaly,
  checkSubscriptionSignups,
  type Alert,
} from "@/domain/alerts/checks";

describe("checkNoEmailSends", () => {
  it("fires when no sends and nothing on calendar", () => {
    const alert = checkNoEmailSends({ emailDelivered: 0, smsDelivered: 0, hasUpcomingCalendarEntry: false });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("no-sends");
  });

  it("does not fire when emails were sent", () => {
    const alert = checkNoEmailSends({ emailDelivered: 5000, smsDelivered: 0, hasUpcomingCalendarEntry: false });
    expect(alert).toBeNull();
  });

  it("does not fire when SMS was sent", () => {
    const alert = checkNoEmailSends({ emailDelivered: 0, smsDelivered: 1000, hasUpcomingCalendarEntry: false });
    expect(alert).toBeNull();
  });

  it("does not fire when something is on the calendar", () => {
    const alert = checkNoEmailSends({ emailDelivered: 0, smsDelivered: 0, hasUpcomingCalendarEntry: true });
    expect(alert).toBeNull();
  });
});

describe("checkReelOutperforming", () => {
  it("fires when a reel has 2x+ the average engagement rate", () => {
    const alert = checkReelOutperforming({
      avgEngagementRate: 5.0,
      topPost: { caption: "New planner BTS", engagementRate: 12.0, saves: 95, format: "Reel", permalink: "https://ig/p/1" },
    });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("reel-outperforming");
    expect(alert!.message).toContain("New planner BTS");
  });

  it("does not fire when top post is only slightly above average", () => {
    const alert = checkReelOutperforming({
      avgEngagementRate: 5.0,
      topPost: { caption: "Regular post", engagementRate: 7.0, saves: 20, format: "Reel", permalink: null },
    });
    expect(alert).toBeNull();
  });

  it("does not fire when top post is not a reel", () => {
    const alert = checkReelOutperforming({
      avgEngagementRate: 5.0,
      topPost: { caption: "Image post", engagementRate: 15.0, saves: 50, format: "Image", permalink: null },
    });
    expect(alert).toBeNull();
  });

  it("does not fire when no posts exist", () => {
    const alert = checkReelOutperforming({ avgEngagementRate: null, topPost: null });
    expect(alert).toBeNull();
  });
});

describe("checkRoasDropped", () => {
  it("fires when ROAS dropped 40%+ week over week", () => {
    const alert = checkRoasDropped({ thisWeekRoas: 1.5, lastWeekRoas: 3.0 });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("roas-drop");
  });

  it("does not fire for small drops", () => {
    const alert = checkRoasDropped({ thisWeekRoas: 2.5, lastWeekRoas: 3.0 });
    expect(alert).toBeNull();
  });

  it("does not fire when ROAS improved", () => {
    const alert = checkRoasDropped({ thisWeekRoas: 4.0, lastWeekRoas: 3.0 });
    expect(alert).toBeNull();
  });

  it("does not fire when no data", () => {
    const alert = checkRoasDropped({ thisWeekRoas: null, lastWeekRoas: null });
    expect(alert).toBeNull();
  });
});

describe("checkRevenueAnomaly", () => {
  it("fires on significant revenue drop (not 1st of month)", () => {
    const alert = checkRevenueAnomaly({
      todayRevenueCents: 5000,
      trailingAvgRevenueCents: 20000,
      todayDate: new Date("2025-07-15"), // mid-month
    });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("revenue-anomaly");
  });

  it("ignores 1st of month spikes (subscription billing)", () => {
    const alert = checkRevenueAnomaly({
      todayRevenueCents: 80000,
      trailingAvgRevenueCents: 20000,
      todayDate: new Date("2025-08-01"),
    });
    expect(alert).toBeNull();
  });

  it("does not fire for normal variation", () => {
    const alert = checkRevenueAnomaly({
      todayRevenueCents: 18000,
      trailingAvgRevenueCents: 20000,
      todayDate: new Date("2025-07-15"),
    });
    expect(alert).toBeNull();
  });
});

describe("checkSubscriptionSignups", () => {
  it("fires when zero signups in the past week", () => {
    const alert = checkSubscriptionSignups({ newSubscribers: 0, avgWeeklySubscribers: 5 });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("sub-drought");
  });

  it("fires on a surge (3x+ average)", () => {
    const alert = checkSubscriptionSignups({ newSubscribers: 20, avgWeeklySubscribers: 5 });
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe("sub-surge");
  });

  it("does not fire for normal activity", () => {
    const alert = checkSubscriptionSignups({ newSubscribers: 6, avgWeeklySubscribers: 5 });
    expect(alert).toBeNull();
  });

  it("does not fire when no historical average", () => {
    const alert = checkSubscriptionSignups({ newSubscribers: 3, avgWeeklySubscribers: 0 });
    expect(alert).toBeNull();
  });
});
