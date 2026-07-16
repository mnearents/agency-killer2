import { describe, it, expect } from "vitest";
import { formatAdsStatus, type AdsStatusResult, type CampaignStatus } from "@/domain/meta/status";
import type { DerivedMetrics } from "@/domain/meta/metrics";

const SAMPLE_METRICS: DerivedMetrics = {
  spendDollars: 50,
  revenueDollars: 150,
  roas: 3.0,
  costPerPurchaseDollars: 10,
  ctr: 2.0,
  cpm: 5.0,
  cpc: 0.25,
  conversionRate: 2.5,
  addToCartRate: 15,
  checkoutRate: 50,
};

describe("formatAdsStatus", () => {
  it("formats active campaigns with metrics", () => {
    const result: AdsStatusResult = {
      campaigns: [
        { id: "camp_1", name: "Summer Sale", status: "ACTIVE", metrics: SAMPLE_METRICS },
      ],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    };
    const text = formatAdsStatus(result);
    expect(text).toContain("Summer Sale");
    expect(text).toContain("$50.00");
    expect(text).toContain("$150.00");
    expect(text).toContain("3.00");
  });

  it("returns helpful message when no campaigns", () => {
    const result: AdsStatusResult = {
      campaigns: [],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    };
    const text = formatAdsStatus(result);
    expect(text).toContain("No active campaigns");
  });

  it("handles null metrics gracefully", () => {
    const nullMetrics: DerivedMetrics = {
      spendDollars: 0, revenueDollars: 0, roas: null,
      costPerPurchaseDollars: null, ctr: null, cpm: null,
      cpc: null, conversionRate: null, addToCartRate: null, checkoutRate: null,
    };
    const result: AdsStatusResult = {
      campaigns: [
        { id: "camp_1", name: "New Campaign", status: "ACTIVE", metrics: nullMetrics },
      ],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    };
    const text = formatAdsStatus(result);
    expect(text).toContain("New Campaign");
    expect(text).toContain("N/A");
    expect(text).not.toContain("undefined");
  });

  it("formats multiple campaigns", () => {
    const result: AdsStatusResult = {
      campaigns: [
        { id: "camp_1", name: "Summer Sale", status: "ACTIVE", metrics: SAMPLE_METRICS },
        { id: "camp_2", name: "Fall Collection", status: "ACTIVE", metrics: SAMPLE_METRICS },
      ],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    };
    const text = formatAdsStatus(result);
    expect(text).toContain("Summer Sale");
    expect(text).toContain("Fall Collection");
  });

  it("includes date range in header", () => {
    const result: AdsStatusResult = {
      campaigns: [
        { id: "camp_1", name: "Test", status: "ACTIVE", metrics: SAMPLE_METRICS },
      ],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    };
    const text = formatAdsStatus(result);
    expect(text).toContain("2025-06-01");
    expect(text).toContain("2025-06-07");
  });
});
