import { vi } from "vitest";
import type { MetaApiClient } from "@/integrations/meta-api";

export function createMockMetaApiClient(
  overrides?: Partial<MetaApiClient>
): MetaApiClient {
  return {
    getCampaigns: vi.fn().mockResolvedValue([]),
    getAdSets: vi.fn().mockResolvedValue([]),
    getAds: vi.fn().mockResolvedValue([]),
    getCreatives: vi.fn().mockResolvedValue([]),
    getInsights: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
