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
    expect(text).toContain("No campaigns");
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

/**
 * `!meta status` filtered on status === "ACTIVE". Every campaign on this account
 * is paused, so the command reported "No active campaigns found... make sure
 * Meta sync has run" — pointing at the sync for what was actually a deliberate,
 * months-old business decision to stop spending.
 *
 * Paused is a state, not an absence. These tests hold that line.
 */
describe("formatAdsStatus with paused campaigns", () => {
  const paused = (name: string): CampaignStatus => ({
    id: `camp_${name}`, name, status: "PAUSED", metrics: SAMPLE_METRICS,
  });

  it("reports paused campaigns instead of hiding them", () => {
    const text = formatAdsStatus({
      campaigns: [paused("Summer Sale")],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    });
    expect(text).toContain("Summer Sale");
  });

  it("labels each campaign so paused is never mistaken for running", () => {
    const text = formatAdsStatus({
      campaigns: [
        { id: "camp_1", name: "Live One", status: "ACTIVE", metrics: SAMPLE_METRICS },
        paused("Stopped One"),
      ],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    });
    expect(text).toMatch(/Stopped One.*\n?.*[Pp]aused|[Pp]aused.*Stopped One/s);
    expect(text).toContain("Live One");
  });

  it("says plainly that nothing is running when every campaign is paused", () => {
    // Tara reads this. It must not require knowing what "ACTIVE" means, and it
    // must not blame the sync for a choice someone made on purpose.
    const text = formatAdsStatus({
      campaigns: [paused("A"), paused("B")],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    });
    expect(text.toLowerCase()).toContain("nothing is running");
    expect(text.toLowerCase()).not.toContain("make sure meta sync has run");
  });

  it("does not claim nothing is running when something is", () => {
    const text = formatAdsStatus({
      campaigns: [
        { id: "camp_1", name: "Live One", status: "ACTIVE", metrics: SAMPLE_METRICS },
        paused("Stopped One"),
      ],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    });
    expect(text.toLowerCase()).not.toContain("nothing is running");
  });

  it("distinguishes an empty campaign table from an all-paused account", () => {
    const empty = formatAdsStatus({
      campaigns: [],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    });
    const allPaused = formatAdsStatus({
      campaigns: [paused("A")],
      dateRange: { start: "2025-06-01", end: "2025-06-07" },
    });
    expect(empty).not.toEqual(allPaused);
    // Zero campaigns really can mean the sync never landed — say so only here.
    expect(empty.toLowerCase()).toContain("sync");
  });
});
