/**
 * Social post metrics — pure math, no DB, no model.
 *
 * Key metrics for organic IG content:
 * - Engagement rate: (likes + comments + saves + shares) / reach
 * - Save rate: saves / reach (strong signal — user bookmarked it)
 * - Share rate: shares / reach (virality signal)
 * - Reach rate: reach / impressions (how many unique users saw it)
 */

export interface PostRow {
  likeCount: number;
  commentsCount: number;
  saved: number;
  shares: number;
  impressions: number;
  reach: number;
  plays: number;
  mediaType: string;
  mediaProductType: string | null;
}

export interface PostMetrics {
  engagementRate: number | null;
  saveRate: number | null;
  shareRate: number | null;
  reachRate: number | null;
  totalEngagements: number;
  isReel: boolean;
  plays: number;
}

export interface FormatBreakdown {
  format: string;
  count: number;
  avgEngagementRate: number | null;
  avgSaveRate: number | null;
  avgReach: number;
  avgPlays: number;
}

function safeDiv(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

function safePercent(numerator: number, denominator: number): number | null {
  const result = safeDiv(numerator, denominator);
  return result !== null ? result * 100 : null;
}

export function computePostMetrics(post: PostRow): PostMetrics {
  const totalEngagements =
    post.likeCount + post.commentsCount + post.saved + post.shares;

  return {
    engagementRate: safePercent(totalEngagements, post.reach),
    saveRate: safePercent(post.saved, post.reach),
    shareRate: safePercent(post.shares, post.reach),
    reachRate: safePercent(post.reach, post.impressions),
    totalEngagements,
    isReel: post.mediaProductType === "REELS",
    plays: post.plays,
  };
}

export function rankPosts(
  posts: PostRow[],
  sortBy: keyof Pick<PostMetrics, "engagementRate" | "saveRate" | "shareRate" | "reachRate">
): PostMetrics[] {
  return posts
    .map((p) => computePostMetrics(p))
    .sort((a, b) => {
      const aVal = a[sortBy] ?? -Infinity;
      const bVal = b[sortBy] ?? -Infinity;
      return bVal - aVal;
    });
}

function getFormatLabel(mediaType: string, mediaProductType: string | null): string {
  if (mediaProductType === "REELS") return "Reel";
  if (mediaProductType === "STORY") return "Story";
  if (mediaType === "CAROUSEL_ALBUM") return "Carousel";
  if (mediaType === "VIDEO") return "Video";
  return "Image";
}

export function computeFormatBreakdown(posts: PostRow[]): FormatBreakdown[] {
  if (posts.length === 0) return [];

  const grouped = new Map<string, PostRow[]>();
  for (const post of posts) {
    const format = getFormatLabel(post.mediaType, post.mediaProductType);
    const existing = grouped.get(format) ?? [];
    existing.push(post);
    grouped.set(format, existing);
  }

  const results: FormatBreakdown[] = [];
  for (const [format, formatPosts] of grouped) {
    const metrics = formatPosts.map((p) => computePostMetrics(p));

    const engRates = metrics
      .map((m) => m.engagementRate)
      .filter((r): r is number => r !== null);
    const saveRates = metrics
      .map((m) => m.saveRate)
      .filter((r): r is number => r !== null);

    results.push({
      format,
      count: formatPosts.length,
      avgEngagementRate:
        engRates.length > 0
          ? engRates.reduce((a, b) => a + b, 0) / engRates.length
          : null,
      avgSaveRate:
        saveRates.length > 0
          ? saveRates.reduce((a, b) => a + b, 0) / saveRates.length
          : null,
      avgReach: formatPosts.reduce((a, p) => a + p.reach, 0) / formatPosts.length,
      avgPlays: formatPosts.reduce((a, p) => a + p.plays, 0) / formatPosts.length,
    });
  }

  return results;
}
