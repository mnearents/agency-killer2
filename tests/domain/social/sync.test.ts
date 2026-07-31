import { describe, it, expect } from "vitest";
import {
  transformMediaToPost,
  type TransformInput,
} from "@/domain/social/sync";
import type { IgMedia, IgMediaInsights } from "@/integrations/instagram-api";

function makeMedia(overrides: Partial<IgMedia> = {}): IgMedia {
  return {
    id: "17890000000000001",
    caption: "New stationery drop! 🎨✨ #radandhappy",
    media_type: "IMAGE",
    media_product_type: "FEED",
    permalink: "https://www.instagram.com/p/abc123/",
    thumbnail_url: undefined,
    media_url: "https://scontent.cdninstagram.com/image.jpg",
    timestamp: "2026-07-15T14:30:00+0000",
    like_count: 245,
    comments_count: 18,
    ...overrides,
  };
}

function makeInsights(overrides: Partial<IgMediaInsights> = {}): IgMediaInsights {
  return {
    mediaId: "17890000000000001",
    impressions: 5200,
    reach: 3800,
    saved: 92,
    shares: 15,
    plays: 0,
    totalInteractions: 370,
    ...overrides,
  };
}

describe("transformMediaToPost", () => {
  const igUserId = "17841400000000000";
  const syncedAt = new Date("2026-07-28T12:00:00Z");

  it("transforms a feed image post with insights", () => {
    const input: TransformInput = {
      media: makeMedia(),
      insights: makeInsights(),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.id).toBe("17890000000000001");
    expect(result.igUserId).toBe(igUserId);
    expect(result.caption).toBe("New stationery drop! 🎨✨ #radandhappy");
    expect(result.mediaType).toBe("IMAGE");
    expect(result.mediaProductType).toBe("FEED");
    expect(result.permalink).toBe("https://www.instagram.com/p/abc123/");
    expect(result.likeCount).toBe(245);
    expect(result.commentsCount).toBe(18);
    expect(result.impressions).toBe(5200);
    expect(result.reach).toBe(3800);
    expect(result.saved).toBe(92);
    expect(result.shares).toBe(15);
    expect(result.plays).toBe(0);
    expect(result.totalInteractions).toBe(370);
    expect(result.postedAt).toEqual(new Date("2026-07-15T14:30:00+0000"));
    expect(result.syncedAt).toEqual(syncedAt);
  });

  it("transforms a reel with plays", () => {
    const input: TransformInput = {
      media: makeMedia({
        id: "reel-1",
        media_type: "VIDEO",
        media_product_type: "REELS",
        thumbnail_url: "https://scontent.cdninstagram.com/thumb.jpg",
      }),
      insights: makeInsights({
        mediaId: "reel-1",
        plays: 12500,
        shares: 45,
      }),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.mediaType).toBe("VIDEO");
    expect(result.mediaProductType).toBe("REELS");
    expect(result.plays).toBe(12500);
    expect(result.shares).toBe(45);
    expect(result.thumbnailUrl).toBe("https://scontent.cdninstagram.com/thumb.jpg");
  });

  it("transforms a carousel post", () => {
    const input: TransformInput = {
      media: makeMedia({
        id: "carousel-1",
        media_type: "CAROUSEL_ALBUM",
        media_product_type: "FEED",
      }),
      insights: makeInsights({ mediaId: "carousel-1" }),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.mediaType).toBe("CAROUSEL_ALBUM");
    expect(result.mediaProductType).toBe("FEED");
  });

  it("handles missing caption", () => {
    const input: TransformInput = {
      media: makeMedia({ caption: undefined }),
      insights: makeInsights(),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.caption).toBeNull();
  });

  it("handles missing like_count and comments_count", () => {
    const input: TransformInput = {
      media: makeMedia({ like_count: undefined, comments_count: undefined }),
      insights: makeInsights(),
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.likeCount).toBe(0);
    expect(result.commentsCount).toBe(0);
  });

  it("uses null insights when insights fetch failed", () => {
    const input: TransformInput = {
      media: makeMedia(),
      insights: null,
      igUserId,
      syncedAt,
    };

    const result = transformMediaToPost(input);

    expect(result.impressions).toBe(0);
    expect(result.reach).toBe(0);
    expect(result.saved).toBe(0);
    expect(result.shares).toBe(0);
    expect(result.plays).toBe(0);
    expect(result.totalInteractions).toBe(0);
    // Basic engagement from media object is still available
    expect(result.likeCount).toBe(245);
    expect(result.commentsCount).toBe(18);
  });
});
