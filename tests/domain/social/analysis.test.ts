import { describe, it, expect } from "vitest";
import {
  formatPostsBlock,
  formatBreakdownBlock,
  formatStatusBlock,
  buildSocialAnalysisRequest,
  type SocialAnalysisInput,
  type PostSummaryForPrompt,
} from "@/domain/social/analysis";
import type { FormatBreakdown } from "@/domain/social/metrics";
import type { VoicePromptResult } from "@/domain/voice/voice";

const mockVoice: VoicePromptResult = {
  systemPrompt: "You are a brand voice assistant.",
  guardrailOptions: {
    bannedWords: ["synergy"],
    checkPii: true,
    checkFabricatedStats: false,
  },
};

function makePostSummary(overrides: Partial<PostSummaryForPrompt> = {}): PostSummaryForPrompt {
  return {
    caption: "New planner drop! 🎨 #radandhappy",
    mediaType: "IMAGE",
    mediaProductType: "FEED",
    permalink: "https://www.instagram.com/p/abc123/",
    engagementRate: 7.5,
    saveRate: 3.2,
    shareRate: 0.8,
    reach: 3000,
    impressions: 5000,
    plays: 0,
    isReel: false,
    postedAt: "2026-07-15",
    ...overrides,
  };
}

describe("formatPostsBlock", () => {
  it("formats top posts with metrics for the AI prompt", () => {
    const posts: PostSummaryForPrompt[] = [
      makePostSummary({ caption: "Post A", engagementRate: 12.5, saveRate: 5.0 }),
      makePostSummary({ caption: "Post B", engagementRate: 8.0, saveRate: 2.1 }),
    ];

    const result = formatPostsBlock(posts);

    expect(result).toContain("Post A");
    expect(result).toContain("Post B");
    expect(result).toContain("12.50%");
    expect(result).toContain("5.00%");
    expect(result).toContain("Image");
  });

  it("shows plays for reels", () => {
    const posts: PostSummaryForPrompt[] = [
      makePostSummary({ isReel: true, plays: 15000, mediaProductType: "REELS" }),
    ];

    const result = formatPostsBlock(posts);

    expect(result).toContain("15,000 plays");
    expect(result).toContain("Reel");
  });

  it("truncates long captions", () => {
    const longCaption = "A".repeat(200);
    const posts: PostSummaryForPrompt[] = [
      makePostSummary({ caption: longCaption }),
    ];

    const result = formatPostsBlock(posts);

    expect(result).toContain("...");
    expect(result.length).toBeLessThan(longCaption.length + 500);
  });
});

describe("formatBreakdownBlock", () => {
  it("formats format breakdown for the AI prompt", () => {
    const breakdown: FormatBreakdown[] = [
      { format: "Image", count: 10, avgEngagementRate: 6.5, avgSaveRate: 2.1, avgReach: 2500, avgPlays: 0 },
      { format: "Reel", count: 5, avgEngagementRate: 9.2, avgSaveRate: 4.3, avgReach: 8000, avgPlays: 12000 },
      { format: "Carousel", count: 3, avgEngagementRate: 8.1, avgSaveRate: 3.5, avgReach: 3200, avgPlays: 0 },
    ];

    const result = formatBreakdownBlock(breakdown);

    expect(result).toContain("Image");
    expect(result).toContain("10 posts");
    expect(result).toContain("Reel");
    expect(result).toContain("12,000");
    expect(result).toContain("Carousel");
  });
});

describe("formatStatusBlock", () => {
  it("formats status summary for non-AI Slack response", () => {
    const result = formatStatusBlock({
      totalPosts: 25,
      totalReach: 75000,
      totalImpressions: 120000,
      totalEngagements: 5250,
      avgEngagementRate: 7.0,
      dateRange: { start: "2026-07-01", end: "2026-07-28" },
      followerCount: 12500,
    });

    expect(result).toContain("25");
    expect(result).toContain("75,000");
    expect(result).toContain("7.00%");
    expect(result).toContain("12,500");
  });

  it("handles null engagement rate", () => {
    const result = formatStatusBlock({
      totalPosts: 0,
      totalReach: 0,
      totalImpressions: 0,
      totalEngagements: 0,
      avgEngagementRate: null,
      dateRange: { start: "2026-07-01", end: "2026-07-28" },
      followerCount: null,
    });

    expect(result).toContain("No posts");
  });
});

describe("buildSocialAnalysisRequest", () => {
  it("builds an orchestrator request with metrics and voice", () => {
    const input: SocialAnalysisInput = {
      topPosts: [makePostSummary()],
      bottomPosts: [makePostSummary({ engagementRate: 1.0 })],
      breakdown: [
        { format: "Image", count: 10, avgEngagementRate: 6.5, avgSaveRate: 2.1, avgReach: 2500, avgPlays: 0 },
      ],
      dateRange: { start: "2026-07-01", end: "2026-07-28" },
      followerCount: 12500,
      voice: mockVoice,
    };

    const request = buildSocialAnalysisRequest(input);

    expect(request.prompt).toContain("organic Instagram");
    expect(request.prompt).toContain("7.50%"); // top post engagement rate
    expect(request.system).toContain("creative strategist");
    expect(request.system).toContain(mockVoice.systemPrompt);
    // Fabricated stats check should be OFF for analysis (we're feeding real numbers)
    expect(request.guardrails?.checkFabricatedStats).toBe(false);
  });

  it("includes KB context when provided", () => {
    const input: SocialAnalysisInput = {
      topPosts: [makePostSummary()],
      bottomPosts: [],
      breakdown: [],
      dateRange: { start: "2026-07-01", end: "2026-07-28" },
      followerCount: null,
      voice: mockVoice,
      kbContext: "From meeting notes: Tara wants more behind-the-scenes content.",
    };

    const request = buildSocialAnalysisRequest(input);

    expect(request.prompt).toContain("behind-the-scenes");
  });
});
