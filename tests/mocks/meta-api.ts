import { vi } from "vitest";
import type { MetaApiClient } from "@/integrations/meta-api";

export function createMockMetaApiClient(
  overrides?: Partial<MetaApiClient>
): MetaApiClient {
  return {
    getWatchSnapshot: vi.fn().mockResolvedValue({ account: { id: "act_mock" }, campaigns: [], adsets: [], ads: [] }),
    getActivities: vi.fn().mockResolvedValue([]),
    getCampaigns: vi.fn().mockResolvedValue([]),
    getAdSets: vi.fn().mockResolvedValue([]),
    getAds: vi.fn().mockResolvedValue([]),
    getCreatives: vi.fn().mockResolvedValue([]),
    getInsights: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
