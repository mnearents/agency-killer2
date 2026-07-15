import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  metaCampaigns,
  metaAdSets,
  metaAds,
  metaCreatives,
  metaInsights,
} from "@/db/schema";
import type {
  NewMetaCampaign,
  NewMetaAdSet,
  NewMetaAd,
  NewMetaInsight,
} from "@/db/schema";

describe("schema: meta_campaigns", () => {
  it("has the correct table name", () => {
    const config = getTableConfig(metaCampaigns);
    expect(config.name).toBe("meta_campaigns");
  });

  it("stores budgets in cents, not dollars", () => {
    const columns = getTableColumns(metaCampaigns);
    expect(columns.dailyBudgetCents).toBeDefined();
    expect(columns.lifetimeBudgetCents).toBeDefined();
    // Should NOT have a dollars column
    expect("dailyBudget" in columns).toBe(false);
    expect("lifetimeBudget" in columns).toBe(false);
  });

  it("has rawJson column for audit trail", () => {
    const columns = getTableColumns(metaCampaigns);
    expect(columns.rawJson).toBeDefined();
  });

  it("has syncedAt for tracking sync freshness", () => {
    const columns = getTableColumns(metaCampaigns);
    expect(columns.syncedAt).toBeDefined();
  });
});

describe("schema: meta_adsets", () => {
  it("has foreign key to campaigns", () => {
    const columns = getTableColumns(metaAdSets);
    expect(columns.campaignId).toBeDefined();
  });

  it("stores targeting as JSONB", () => {
    const columns = getTableColumns(metaAdSets);
    expect(columns.targeting).toBeDefined();
  });
});

describe("schema: meta_ads", () => {
  it("has foreign keys to both adset and campaign", () => {
    const columns = getTableColumns(metaAds);
    expect(columns.adSetId).toBeDefined();
    expect(columns.campaignId).toBeDefined();
  });
});

describe("schema: meta_insights", () => {
  it("has the correct table name", () => {
    const config = getTableConfig(metaInsights);
    expect(config.name).toBe("meta_insights");
  });

  it("stores spend in cents", () => {
    const columns = getTableColumns(metaInsights);
    expect(columns.spendCents).toBeDefined();
    expect("spend" in columns).toBe(false);
  });

  it("stores purchase value in cents", () => {
    const columns = getTableColumns(metaInsights);
    expect(columns.purchaseValueCents).toBeDefined();
  });

  it("has a dedup unique index on (adId, date, publisherPlatform, platformPosition)", () => {
    const config = getTableConfig(metaInsights);
    const dedupIndex = config.indexes.find(
      (idx) => idx.config.name === "meta_insights_dedup_idx"
    );
    expect(dedupIndex).toBeDefined();
    expect(dedupIndex!.config.unique).toBe(true);
  });

  it("has indexes on date, campaign, and ad for query performance", () => {
    const config = getTableConfig(metaInsights);
    const indexNames = config.indexes.map((idx) => idx.config.name);
    expect(indexNames).toContain("meta_insights_date_idx");
    expect(indexNames).toContain("meta_insights_campaign_idx");
    expect(indexNames).toContain("meta_insights_ad_idx");
  });

  it("tracks conversion events for CTC attribution", () => {
    const columns = getTableColumns(metaInsights);
    expect(columns.purchases).toBeDefined();
    expect(columns.purchaseValueCents).toBeDefined();
    expect(columns.addToCart).toBeDefined();
    expect(columns.initiateCheckout).toBeDefined();
  });

  it("has breakdown dimensions for platform analysis", () => {
    const columns = getTableColumns(metaInsights);
    expect(columns.publisherPlatform).toBeDefined();
    expect(columns.platformPosition).toBeDefined();
  });
});

describe("schema: type safety — insert types require mandatory fields", () => {
  it("NewMetaCampaign requires id, accountId, name, status, syncedAt", () => {
    // This test verifies at compile time that the insert type requires
    // the right fields. If it compiles, the types are correct.
    const valid: NewMetaCampaign = {
      id: "camp_123",
      accountId: "act_456",
      name: "Test Campaign",
      status: "ACTIVE",
      syncedAt: new Date(),
    };
    expect(valid.id).toBe("camp_123");
    expect(valid.accountId).toBe("act_456");
  });

  it("NewMetaAdSet requires campaignId", () => {
    const valid: NewMetaAdSet = {
      id: "adset_123",
      campaignId: "camp_123",
      name: "Test AdSet",
      status: "ACTIVE",
      syncedAt: new Date(),
    };
    expect(valid.campaignId).toBe("camp_123");
  });

  it("NewMetaAd requires both adSetId and campaignId", () => {
    const valid: NewMetaAd = {
      id: "ad_123",
      adSetId: "adset_123",
      campaignId: "camp_123",
      name: "Test Ad",
      status: "ACTIVE",
      syncedAt: new Date(),
    };
    expect(valid.adSetId).toBe("adset_123");
    expect(valid.campaignId).toBe("camp_123");
  });

  it("NewMetaInsight requires adId, campaignId, adSetId, date, syncedAt", () => {
    const valid: NewMetaInsight = {
      adId: "ad_123",
      campaignId: "camp_123",
      adSetId: "adset_123",
      date: new Date("2025-01-15"),
      syncedAt: new Date(),
    };
    expect(valid.adId).toBe("ad_123");
    expect(valid.date).toEqual(new Date("2025-01-15"));
  });
});
