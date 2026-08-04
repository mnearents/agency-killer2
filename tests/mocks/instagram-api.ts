import { vi } from "vitest";
import type { InstagramApiClient } from "@/integrations/instagram-api";

export function createMockInstagramApiClient(
  overrides?: Partial<InstagramApiClient>
): InstagramApiClient {
  return {
    getAccountInfo: vi.fn().mockResolvedValue({
      id: "17841400000000000",
      username: "radandhappy",
      followers_count: 12500,
      media_count: 340,
    }),
    getRecentMedia: vi.fn().mockResolvedValue([]),
    getStories: vi.fn().mockResolvedValue([]),
    getMediaInsights: vi.fn().mockResolvedValue({
      mediaId: "mock-media-id",
      impressions: 0,
      reach: 0,
      saved: 0,
      shares: 0,
      plays: 0,
      totalInteractions: 0,
    }),
    ...overrides,
  };
}
