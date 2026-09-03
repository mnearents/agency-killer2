import { describe, it, expect, vi } from "vitest";
import {
  syncStructure,
  syncInsights,
  syncIncremental,
  recordUnconfiguredSync,
  type SyncDeps,
} from "@/domain/meta/sync";
import { MetaApiError } from "@/integrations/meta-api";
import { createMockMetaApiClient } from "../../mocks/meta-api";
import type { MetaApiCampaign, MetaApiInsight } from "@/integrations/meta-api";

const NOW = new Date("2026-09-02T13:00:00Z");

/**
 * Mock the Drizzle DB with a fake that records insert calls.
 * We can't run real SQL in the fast tier, but we can verify the
 * sync service calls insert with the right data.
 *
 * `_runs` collects `sync_runs` writes — recognised by their `outcome` field —
 * so a test can assert what the sync recorded about itself.
 */
function createMockDb() {
  const runs: Array<Record<string, unknown>> = [];
  const inserted: unknown[] = [];

  const db = {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        if (v && typeof v.outcome === "string") runs.push(v);
        else inserted.push(v);
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        };
      }),
    })),
    _runs: runs,
    _inserted: inserted,
  };

  return db as unknown as SyncDeps["db"] & {
    insert: ReturnType<typeof vi.fn>;
    _runs: Array<Record<string, unknown>>;
  };
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

  /**
   * The four situations below all used to produce the same log line and the same
   * (absent) database state. Each test asserts one of them is now distinguishable
   * from the others by what the run recorded about itself.
   */
  it("records an ok run when rows were written", async () => {
    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockResolvedValue([
        { id: "camp_1", name: "Test", status: "PAUSED" },
      ]),
    });
    const db = createMockDb();

    const result = await syncIncremental(
      { client, db, accountId: "act_123", now: () => NOW },
      7
    );

    expect(result.outcome).toBe("ok");
    expect(db._runs).toHaveLength(1);
    expect(db._runs[0].task).toBe("sync:meta");
    expect(db._runs[0].outcome).toBe("ok");
    expect(db._runs[0].startedAt).toEqual(NOW);
  });

  it("records no-data when the account genuinely returned nothing", async () => {
    // A paused account with no recent spend. Nothing is wrong here — and the
    // record has to say so, rather than leaving a human to guess.
    const client = createMockMetaApiClient();
    const db = createMockDb();

    const result = await syncIncremental(
      { client, db, accountId: "act_123", now: () => NOW },
      7
    );

    expect(result.outcome).toBe("no-data");
    expect(db._runs[0].outcome).toBe("no-data");
    expect(db._runs[0].rowsWritten).toBe(0);
  });

  it("records auth-failed with Meta's code when the token is dead", async () => {
    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockRejectedValue(
        new MetaApiError("Error validating access token: Session expired", 190)
      ),
      getAdSets: vi.fn().mockRejectedValue(new MetaApiError("Session expired", 190)),
      getAds: vi.fn().mockRejectedValue(new MetaApiError("Session expired", 190)),
      getCreatives: vi.fn().mockRejectedValue(new MetaApiError("Session expired", 190)),
      getInsights: vi.fn().mockRejectedValue(new MetaApiError("Session expired", 190)),
    });
    const db = createMockDb();

    const result = await syncIncremental(
      { client, db, accountId: "act_123", now: () => NOW },
      7
    );

    expect(result.outcome).toBe("auth-failed");
    expect(db._runs[0].outcome).toBe("auth-failed");
    expect(db._runs[0].errorCode).toBe(190);
    expect(db._runs[0].errorMessage).toContain("Session expired");
  });

  it("does not report a partially failed run as no-data", async () => {
    // Insights failed; structure succeeded but wrote zero insight rows. Reporting
    // "no-data" here would say "the account had no spend" about an API outage.
    const client = createMockMetaApiClient({
      getCampaigns: vi.fn().mockResolvedValue([
        { id: "camp_1", name: "Test", status: "ACTIVE" },
      ]),
      getInsights: vi.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET")),
    });
    const db = createMockDb();

    const result = await syncIncremental(
      { client, db, accountId: "act_123", now: () => NOW },
      7
    );

    expect(result.outcome).toBe("api-error");
    expect(db._runs[0].outcome).toBe("api-error");
  });

  it("stamps the insight window on the run so a gap is traceable to dates", async () => {
    const client = createMockMetaApiClient();
    const db = createMockDb();

    await syncIncremental(
      { client, db, accountId: "act_123", now: () => NOW },
      7
    );

    // 7 days back from 2026-09-02.
    expect(db._runs[0].windowStart).toEqual(new Date("2026-08-26T00:00:00Z"));
    expect(db._runs[0].windowEnd).toEqual(new Date("2026-09-02T00:00:00Z"));
  });
});

describe("recordUnconfiguredSync", () => {
  it("writes a not-configured run so a skipped task is not an absent one", async () => {
    // The exact production failure: META_AD_ACCOUNT_ID was unset, the task
    // returned before calling Meta, and nothing was written anywhere. "Never ran"
    // and "ran and found nothing" have to leave different traces.
    const db = createMockDb();

    await recordUnconfiguredSync(db, "META_AD_ACCOUNT_ID", () => NOW);

    expect(db._runs).toHaveLength(1);
    expect(db._runs[0].outcome).toBe("not-configured");
    expect(db._runs[0].task).toBe("sync:meta");
    expect(db._runs[0].rowsWritten).toBe(0);
    expect(db._runs[0].errorMessage).toContain("META_AD_ACCOUNT_ID");
  });
});
