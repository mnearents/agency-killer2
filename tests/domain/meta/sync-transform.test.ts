import { describe, it, expect } from "vitest";
import {
  transformCampaign,
  transformAdSet,
  transformAd,
  transformCreative,
  transformInsight,
} from "@/domain/meta/sync-transform";
import type { MetaApiInsight } from "@/integrations/meta-api";

const SYNCED_AT = new Date("2025-06-15T12:00:00Z");

describe("transformCampaign", () => {
  it("maps all required fields", () => {
    const result = transformCampaign(
      {
        id: "camp_123",
        name: "Summer Sale",
        status: "ACTIVE",
        objective: "CONVERSIONS",
        buying_type: "AUCTION",
        daily_budget: "5000", // already in cents from Meta
        lifetime_budget: "100000",
      },
      SYNCED_AT
    );

    expect(result.id).toBe("camp_123");
    expect(result.name).toBe("Summer Sale");
    expect(result.status).toBe("ACTIVE");
    expect(result.objective).toBe("CONVERSIONS");
    expect(result.syncedAt).toEqual(SYNCED_AT);
  });

  it("passes budgets through as-is (Meta sends cents)", () => {
    const result = transformCampaign(
      {
        id: "camp_123",
        name: "Test",
        status: "ACTIVE",
        daily_budget: "5000",
        lifetime_budget: "100000",
      },
      SYNCED_AT
    );

    // Meta budgets are already in cents — do NOT multiply by 100
    expect(result.dailyBudgetCents).toBe(5000);
    expect(result.lifetimeBudgetCents).toBe(100000);
  });

  it("handles missing optional fields", () => {
    const result = transformCampaign(
      { id: "camp_456", name: "Minimal", status: "PAUSED" },
      SYNCED_AT
    );

    expect(result.id).toBe("camp_456");
    expect(result.dailyBudgetCents).toBeNull();
    expect(result.lifetimeBudgetCents).toBeNull();
  });

  it("stores raw JSON for audit trail", () => {
    const raw = { id: "camp_789", name: "Audit", status: "ACTIVE" };
    const result = transformCampaign(raw, SYNCED_AT);
    expect(result.rawJson).toEqual(raw);
  });
});

describe("transformInsight: dollar-to-cent conversion", () => {
  const BASE_INSIGHT: MetaApiInsight = {
    ad_id: "ad_1",
    adset_id: "adset_1",
    campaign_id: "camp_1",
    date_start: "2025-06-01",
    impressions: "1000",
    clicks: "50",
    spend: "12.34", // DOLLARS — must become 1234 cents
    reach: "800",
    cpm: "12.34", // DOLLARS
    cpc: "0.25", // DOLLARS
    ctr: "5.0",
    publisher_platform: "facebook",
    platform_position: "feed",
  };

  it("converts spend from dollars to cents", () => {
    const result = transformInsight(BASE_INSIGHT, SYNCED_AT);
    expect(result.spendCents).toBe(1234);
  });

  it("converts spend with many decimal places correctly", () => {
    const result = transformInsight(
      { ...BASE_INSIGHT, spend: "99.999" },
      SYNCED_AT
    );
    // round(99.999 * 100) = 10000
    expect(result.spendCents).toBe(10000);
  });

  it("converts zero spend", () => {
    const result = transformInsight(
      { ...BASE_INSIGHT, spend: "0" },
      SYNCED_AT
    );
    expect(result.spendCents).toBe(0);
  });

  it("handles missing spend as zero", () => {
    const { spend, ...noSpend } = BASE_INSIGHT;
    const result = transformInsight(noSpend as MetaApiInsight, SYNCED_AT);
    expect(result.spendCents).toBe(0);
  });

  it("passes through cpm and cpc as floats (for display)", () => {
    const result = transformInsight(BASE_INSIGHT, SYNCED_AT);
    expect(result.cpm).toBeCloseTo(12.34);
    expect(result.cpc).toBeCloseTo(0.25);
  });

  it("maps string metrics to numbers", () => {
    const result = transformInsight(BASE_INSIGHT, SYNCED_AT);
    expect(result.impressions).toBe(1000);
    expect(result.clicks).toBe(50);
    expect(result.reach).toBe(800);
    expect(result.ctr).toBeCloseTo(5.0);
  });

  it("maps date_start to a Date object", () => {
    const result = transformInsight(BASE_INSIGHT, SYNCED_AT);
    expect(result.date).toEqual(new Date("2025-06-01"));
  });

  it("maps breakdown dimensions", () => {
    const result = transformInsight(BASE_INSIGHT, SYNCED_AT);
    expect(result.publisherPlatform).toBe("facebook");
    expect(result.platformPosition).toBe("feed");
  });
});

describe("transformInsight: action extraction (7d_click attribution)", () => {
  it("extracts purchase count from actions array", () => {
    const insight: MetaApiInsight = {
      ad_id: "ad_1",
      adset_id: "adset_1",
      campaign_id: "camp_1",
      date_start: "2025-06-01",
      actions: [
        { action_type: "purchase", value: "5", "7d_click": "3" },
        { action_type: "add_to_cart", value: "20", "7d_click": "15" },
        { action_type: "initiate_checkout", value: "10", "7d_click": "8" },
      ],
      action_values: [
        { action_type: "purchase", value: "250.00", "7d_click": "150.00" },
      ],
    };

    const result = transformInsight(insight, SYNCED_AT);

    // Use 7d_click attribution (CTC framework)
    expect(result.purchases).toBe(3);
    expect(result.addToCart).toBe(15);
    expect(result.initiateCheckout).toBe(8);
  });

  it("converts purchase value from dollars to cents using 7d_click", () => {
    const insight: MetaApiInsight = {
      ad_id: "ad_1",
      adset_id: "adset_1",
      campaign_id: "camp_1",
      date_start: "2025-06-01",
      action_values: [
        { action_type: "purchase", value: "250.00", "7d_click": "150.50" },
      ],
    };

    const result = transformInsight(insight, SYNCED_AT);
    // 150.50 dollars = 15050 cents
    expect(result.purchaseValueCents).toBe(15050);
  });

  it("returns zero for missing actions", () => {
    const insight: MetaApiInsight = {
      ad_id: "ad_1",
      adset_id: "adset_1",
      campaign_id: "camp_1",
      date_start: "2025-06-01",
    };

    const result = transformInsight(insight, SYNCED_AT);
    expect(result.purchases).toBe(0);
    expect(result.addToCart).toBe(0);
    expect(result.initiateCheckout).toBe(0);
    expect(result.purchaseValueCents).toBe(0);
  });

  it("falls back to value field when 7d_click is missing", () => {
    const insight: MetaApiInsight = {
      ad_id: "ad_1",
      adset_id: "adset_1",
      campaign_id: "camp_1",
      date_start: "2025-06-01",
      actions: [
        { action_type: "purchase", value: "5" }, // no 7d_click
      ],
    };

    const result = transformInsight(insight, SYNCED_AT);
    expect(result.purchases).toBe(5);
  });
});

describe("transformAd", () => {
  it("maps required fields and extracts creative ID", () => {
    const result = transformAd(
      {
        id: "ad_123",
        adset_id: "adset_456",
        campaign_id: "camp_789",
        name: "Test Ad",
        status: "ACTIVE",
        creative: { id: "cr_111" },
      },
      SYNCED_AT
    );

    expect(result.id).toBe("ad_123");
    expect(result.adSetId).toBe("adset_456");
    expect(result.campaignId).toBe("camp_789");
    expect(result.creativeId).toBe("cr_111");
    expect(result.syncedAt).toEqual(SYNCED_AT);
  });
});

describe("transformCreative", () => {
  it("maps all creative fields", () => {
    const result = transformCreative(
      {
        id: "cr_111",
        name: "Summer Creative",
        title: "Shop Now",
        body: "Best planners ever",
        image_url: "https://example.com/img.jpg",
        call_to_action_type: "SHOP_NOW",
        object_type: "SHARE",
      },
      SYNCED_AT
    );

    expect(result.id).toBe("cr_111");
    expect(result.name).toBe("Summer Creative");
    expect(result.title).toBe("Shop Now");
    expect(result.body).toBe("Best planners ever");
    expect(result.imageUrl).toBe("https://example.com/img.jpg");
    expect(result.callToActionType).toBe("SHOP_NOW");
    expect(result.syncedAt).toEqual(SYNCED_AT);
  });
});
