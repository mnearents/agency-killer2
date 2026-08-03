import { describe, it, expect } from "vitest";
import { parseInsightsResponse, type IgMediaInsight } from "@/integrations/instagram-api";

describe("parseInsightsResponse", () => {
  it("extracts all metrics from a complete response", () => {
    const data: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 5000 }] },
      { name: "reach", period: "lifetime", values: [{ value: 3200 }] },
      { name: "saved", period: "lifetime", values: [{ value: 150 }] },
      { name: "shares", period: "lifetime", values: [{ value: 42 }] },
      { name: "ig_reels_video_view_total", period: "lifetime", values: [{ value: 8000 }] },
      { name: "total_interactions", period: "lifetime", values: [{ value: 620 }] },
    ];

    const result = parseInsightsResponse("media-123", data);

    expect(result).toEqual({
      mediaId: "media-123",
      impressions: 5000,
      reach: 3200,
      saved: 150,
      shares: 42,
      plays: 8000,
      totalInteractions: 620,
    });
  });

  it("defaults missing metrics to 0", () => {
    const data: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 1000 }] },
      { name: "reach", period: "lifetime", values: [{ value: 800 }] },
    ];

    const result = parseInsightsResponse("media-456", data);

    expect(result.saved).toBe(0);
    expect(result.shares).toBe(0);
    expect(result.plays).toBe(0);
    expect(result.totalInteractions).toBe(0);
  });

  it("handles empty data array", () => {
    const result = parseInsightsResponse("media-789", []);

    expect(result).toEqual({
      mediaId: "media-789",
      impressions: 0,
      reach: 0,
      saved: 0,
      shares: 0,
      plays: 0,
      totalInteractions: 0,
    });
  });

  it("reads ig_reels_video_view_total as plays", () => {
    const data: IgMediaInsight[] = [
      { name: "ig_reels_video_view_total", period: "lifetime", values: [{ value: 12000 }] },
    ];

    const result = parseInsightsResponse("reel-1", data);

    expect(result.plays).toBe(12000);
  });

  it("reads views as impressions, falls back to legacy impressions", () => {
    const data: IgMediaInsight[] = [
      { name: "impressions", period: "lifetime", values: [{ value: 9000 }] },
    ];

    const result = parseInsightsResponse("legacy-1", data);
    expect(result.impressions).toBe(9000);

    const data2: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [{ value: 7000 }] },
      { name: "impressions", period: "lifetime", values: [{ value: 9000 }] },
    ];

    const result2 = parseInsightsResponse("both-1", data2);
    expect(result2.impressions).toBe(7000); // views takes priority
  });

  it("handles metrics with empty values array", () => {
    const data: IgMediaInsight[] = [
      { name: "views", period: "lifetime", values: [] },
      { name: "reach", period: "lifetime", values: [{ value: 500 }] },
    ];

    const result = parseInsightsResponse("media-empty", data);

    expect(result.impressions).toBe(0);
    expect(result.reach).toBe(500);
  });
});
