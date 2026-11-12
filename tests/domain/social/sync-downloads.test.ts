import { describe, it, expect, vi } from "vitest";
import { syncSocialPosts } from "@/domain/social/sync";
import * as backfill from "@/domain/social/reel-backfill";
import { createMockInstagramApiClient } from "../../mocks/instagram-api";
import { createMockAnthropicClient } from "../../mocks/anthropic";
import { createMockReelDownloader } from "../../mocks/reel-downloader";
import { fakeDb } from "../../mocks/recording-db";

vi.mock("@/domain/social/reel-backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/social/reel-backfill")>()),
  runReelDownloads: vi.fn().mockResolvedValue({ calls: 1, ok: 1, failed: 0, stopped: null, queued: { own: 1, teacher: 2, peer: 0 }, deferred: { own: 0, teacher: 2, peer: 0 }, results: [] }),
}));

const NOW = new Date("2026-11-12T12:00:00Z");
const visuals = { video: { inspect: vi.fn(), frames: vi.fn(), contactSheet: vi.fn(), extractAudio: vi.fn() }, fetchMedia: vi.fn(), writeTemp: vi.fn() };

describe("syncSocialPosts — reel downloads", () => {
  it("fetches withheld reels when automatic downloads are switched on", async () => {
    const { db } = fakeDb({});
    const r = await syncSocialPosts({
      client: createMockInstagramApiClient(), db, igUserId: "ig1", anthropic: createMockAnthropicClient(), visuals,
      downloads: { downloader: createMockReelDownloader(), limits: { plan: 3, teacher: 60, peer: 40 } }, now: () => NOW, sleep: async () => {},
    });
    expect(backfill.runReelDownloads).toHaveBeenCalledTimes(1);
    expect(r.downloads).toEqual({ configured: true, calls: 1, ok: 1, failed: 0, stopped: null, deferred: { own: 0, teacher: 2, peer: 0 } });
  });

  // Off by default: a quota of three must not be spent by the daily sync unasked.
  it("downloads nothing when they are off, and says so", async () => {
    vi.mocked(backfill.runReelDownloads).mockClear();
    const { db } = fakeDb({});
    const r = await syncSocialPosts({ client: createMockInstagramApiClient(), db, igUserId: "ig1", anthropic: createMockAnthropicClient(), visuals, now: () => NOW, sleep: async () => {} });
    expect(backfill.runReelDownloads).not.toHaveBeenCalled();
    expect(r.downloads.configured).toBe(false);
  });
});
