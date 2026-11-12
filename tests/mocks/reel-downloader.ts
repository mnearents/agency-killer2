import { vi } from "vitest";
import type { ReelDownloaderClient } from "@/integrations/reel-downloader";

export function createMockReelDownloader(overrides: Partial<ReelDownloaderClient> = {}): ReelDownloaderClient & { removed: string[] } {
  const removed: string[] = [];
  return {
    resolve: vi.fn().mockResolvedValue({ ok: true, videoUrl: "https://cdn/v.mp4", quality: "720x1280p", rate: { limit: 3, remaining: 2, resetSeconds: 2_590_961 } }),
    download: vi.fn().mockImplementation(async () => ({
      path: "/tmp/reel.mp4", bytes: 2_000_000, contentType: "video/mp4", remove: async () => { removed.push("/tmp/reel.mp4"); },
    })),
    removed,
    ...overrides,
  };
}
