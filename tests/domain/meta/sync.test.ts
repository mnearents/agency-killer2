import { describe, it, expect, vi } from "vitest";
import { syncStructure, syncInsights, syncIncremental, type SyncDeps } from "@/domain/meta/sync";
import { createMockMetaApiClient } from "../../mocks/meta-api";
import type { MetaApiCampaign, MetaApiInsight } from "@/integrations/meta-api";

/**
 * Mock the Drizzle DB with a fake that records insert calls.
 * We can't run real SQL in the fast tier, but we can verify the
 * sync service calls insert with the right data.
 */
function createMockDb() {
  const insertCalls: Array<{ table: string; values: unknown }> = [];

  const chainable = {
    values: vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    }),
  };

  const db = {
    insert: vi.fn().mockReturnValue(chainable),
    _insertCalls: insertCalls,
  };

  return db as unknown as SyncDeps["db"] & { insert: ReturnType<typeof vi.fn> };
}

describe("syncStructure", () => {
  it("fetches campaigns and inserts them", async () => {
    const mockCampaigns: MetaApiCampaign[] = [
      { id: "camp_1", name: "Summer Sale", status: "ACTIVE" },
      { id: "camp_2", name: "Fall Collection", status: "PAUSED" },
    ];

    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockResolvedValue(mockCampaigns),
    });
    const db = createMockDb();

    const result = await syncStructure({
      client,
      db,
      accountId: "act_123",
    });

    expect(result.campaigns).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(client.getCampaigns).toHaveBeenCalledWith("act_123");
    // Insert called once per campaign + adsets + ads + creatives calls
    expect(db.insert).toHaveBeenCalled();
  });

  it("reports errors without crashing when API fails", async () => {
    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockRejectedValue(new Error("Rate limited")),
    });
    const db = createMockDb();

    const result = await syncStructure({
      client,
      db,
      accountId: "act_123",
    });

    expect(result.campaigns).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Rate limited");
  });

  it("continues syncing other entities when one fails", async () => {
    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockRejectedValue(new Error("Campaign error")),
      getAdSets: vi.fn().mockResolvedValue([
        { id: "adset_1", campaign_id: "camp_1", name: "Test", status: "ACTIVE" },
      ]),
    });
    const db = createMockDb();

    const result = await syncStructure({
      client,
      db,
      accountId: "act_123",
    });

    // Campaigns failed but adsets succeeded
    expect(result.campaigns).toBe(0);
    expect(result.adSets).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});

describe("syncInsights", () => {
  it("fetches and inserts insights for date range", async () => {
    const mockInsights: MetaApiInsight[] = [
      {
        ad_id: "ad_1", adset_id: "adset_1", campaign_id: "camp_1",
        date_start: "2025-06-15", spend: "12.34", impressions: "1000",
      },
    ];

    const client = createMockMetaApiClient({
      getInsights: vi.fn().mockResolvedValue(mockInsights),
    });
    const db = createMockDb();

    const result = await syncInsights(
      { client, db, accountId: "act_123" },
      "2025-06-01",
      "2025-06-30"
    );

    expect(result.insights).toBe(1);
    expect(client.getInsights).toHaveBeenCalledWith("act_123", "2025-06-01", "2025-06-30");
  });
});

describe("syncIncremental", () => {
  it("syncs structure + recent insights", async () => {
    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockResolvedValue([
        { id: "camp_1", name: "Test", status: "ACTIVE" },
      ]),
      getInsights: vi.fn().mockResolvedValue([
        {
          ad_id: "ad_1", adset_id: "adset_1", campaign_id: "camp_1",
          date_start: "2025-06-15", spend: "5.00",
        },
      ]),
    });
    const db = createMockDb();

    const result = await syncIncremental(
      { client, db, accountId: "act_123" },
      7
    );

    expect(result.campaigns).toBe(1);
    expect(result.insights).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});
