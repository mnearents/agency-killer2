/**
 * Social dashboard queries — server-side reads for the Next.js
 * social dashboard page. Returns pre-shaped data for rendering.
 */

import { gte, lte, and, desc, sql, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialPosts } from "@/db/schema";

export interface DailySocialMetrics {
  date: string; // YYYY-MM-DD
  posts: number;
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  plays: number;
}

export async function getDailySocialMetrics(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<DailySocialMetrics[]> {
  const rows = await db
    .select({
      date: sql<string>`DATE(${socialPosts.postedAt})`.as("date"),
      posts: sql<number>`COUNT(*)`.as("posts"),
      reach: sql<number>`COALESCE(SUM(${socialPosts.reach}), 0)`.as("reach"),
      impressions: sql<number>`COALESCE(SUM(${socialPosts.impressions}), 0)`.as("impressions"),
      likes: sql<number>`COALESCE(SUM(${socialPosts.likeCount}), 0)`.as("likes"),
      comments: sql<number>`COALESCE(SUM(${socialPosts.commentsCount}), 0)`.as("comments"),
      saves: sql<number>`COALESCE(SUM(${socialPosts.saved}), 0)`.as("saves"),
      shares: sql<number>`COALESCE(SUM(${socialPosts.shares}), 0)`.as("shares"),
      plays: sql<number>`COALESCE(SUM(${socialPosts.plays}), 0)`.as("plays"),
    })
    .from(socialPosts)
    .where(and(gte(socialPosts.postedAt, startDate), lte(socialPosts.postedAt, endDate)))
    .groupBy(sql`DATE(${socialPosts.postedAt})`)
    .orderBy(sql`DATE(${socialPosts.postedAt})`);

  return rows.map((r) => ({
    date: String(r.date).split("T")[0],
    posts: Number(r.posts),
    reach: Number(r.reach),
    impressions: Number(r.impressions),
    likes: Number(r.likes),
    comments: Number(r.comments),
    saves: Number(r.saves),
    shares: Number(r.shares),
    plays: Number(r.plays),
  }));
}

export interface FormatStats {
  format: string;
  count: number;
  avgEngagementRate: number | null;
  avgSaveRate: number | null;
  totalReach: number;
  totalPlays: number;
}

export async function getFormatStats(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<FormatStats[]> {
  const rows = await db
    .select({
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      count: sql<number>`COUNT(*)`.as("count"),
      totalLikes: sql<number>`COALESCE(SUM(${socialPosts.likeCount}), 0)`.as("total_likes"),
      totalComments: sql<number>`COALESCE(SUM(${socialPosts.commentsCount}), 0)`.as("total_comments"),
      totalSaves: sql<number>`COALESCE(SUM(${socialPosts.saved}), 0)`.as("total_saves"),
      totalShares: sql<number>`COALESCE(SUM(${socialPosts.shares}), 0)`.as("total_shares"),
      totalReach: sql<number>`COALESCE(SUM(${socialPosts.reach}), 0)`.as("total_reach"),
      totalPlays: sql<number>`COALESCE(SUM(${socialPosts.plays}), 0)`.as("total_plays"),
    })
    .from(socialPosts)
    .where(and(gte(socialPosts.postedAt, startDate), lte(socialPosts.postedAt, endDate)))
    .groupBy(socialPosts.mediaType, socialPosts.mediaProductType);

  return rows.map((r) => {
    const totalEng =
      Number(r.totalLikes) + Number(r.totalComments) + Number(r.totalSaves) + Number(r.totalShares);
    const totalReach = Number(r.totalReach);

    let format = "Image";
    if (r.mediaProductType === "REELS") format = "Reel";
    else if (r.mediaProductType === "STORY") format = "Story";
    else if (r.mediaType === "CAROUSEL_ALBUM") format = "Carousel";
    else if (r.mediaType === "VIDEO") format = "Video";

    return {
      format,
      count: Number(r.count),
      avgEngagementRate:
        totalReach > 0 ? (totalEng / totalReach) * 100 : null,
      avgSaveRate:
        totalReach > 0 ? (Number(r.totalSaves) / totalReach) * 100 : null,
      totalReach,
      totalPlays: Number(r.totalPlays),
    };
  });
}

export interface TopPost {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  permalink: string | null;
  likeCount: number;
  commentsCount: number;
  reach: number;
  saved: number;
  shares: number;
  plays: number;
  engagementRate: number | null;
  saveRate: number | null;
  postedAt: string;
}

export async function getTopPosts(
  db: Db,
  startDate: Date,
  endDate: Date,
  limit = 10
): Promise<TopPost[]> {
  const rows = await db
    .select({
      id: socialPosts.id,
      caption: socialPosts.caption,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      permalink: socialPosts.permalink,
      likeCount: socialPosts.likeCount,
      commentsCount: socialPosts.commentsCount,
      reach: socialPosts.reach,
      saved: socialPosts.saved,
      shares: socialPosts.shares,
      plays: socialPosts.plays,
      postedAt: socialPosts.postedAt,
    })
    .from(socialPosts)
    .where(
      and(
        gte(socialPosts.postedAt, startDate),
        lte(socialPosts.postedAt, endDate),
        // Only posts with some reach (exclude posts with no insights yet)
        gte(socialPosts.reach, 1)
      )
    )
    .orderBy(
      // Sort by engagement rate: (likes+comments+saves+shares)/reach DESC
      desc(
        sql`(${socialPosts.likeCount} + ${socialPosts.commentsCount} + ${socialPosts.saved} + ${socialPosts.shares})::float / GREATEST(${socialPosts.reach}, 1)`
      )
    )
    .limit(limit);

  return rows.map((r) => {
    const totalEng = r.likeCount + r.commentsCount + r.saved + r.shares;
    return {
      id: r.id,
      caption: r.caption,
      mediaType: r.mediaType,
      mediaProductType: r.mediaProductType,
      permalink: r.permalink,
      likeCount: r.likeCount,
      commentsCount: r.commentsCount,
      reach: r.reach,
      saved: r.saved,
      shares: r.shares,
      plays: r.plays,
      engagementRate: r.reach > 0 ? (totalEng / r.reach) * 100 : null,
      saveRate: r.reach > 0 ? (r.saved / r.reach) * 100 : null,
      postedAt: r.postedAt.toISOString().split("T")[0],
    };
  });
}

export interface SocialOverview {
  totalPosts: number;
  totalReach: number;
  totalImpressions: number;
  totalLikes: number;
  totalComments: number;
  totalSaves: number;
  totalShares: number;
  avgEngagementRate: number | null;
  avgSaveRate: number | null;
}

export async function getSocialOverview(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<SocialOverview> {
  const [result] = await db
    .select({
      totalPosts: sql<number>`COUNT(*)`.as("total_posts"),
      totalReach: sql<number>`COALESCE(SUM(${socialPosts.reach}), 0)`.as("total_reach"),
      totalImpressions: sql<number>`COALESCE(SUM(${socialPosts.impressions}), 0)`.as("total_impressions"),
      totalLikes: sql<number>`COALESCE(SUM(${socialPosts.likeCount}), 0)`.as("total_likes"),
      totalComments: sql<number>`COALESCE(SUM(${socialPosts.commentsCount}), 0)`.as("total_comments"),
      totalSaves: sql<number>`COALESCE(SUM(${socialPosts.saved}), 0)`.as("total_saves"),
      totalShares: sql<number>`COALESCE(SUM(${socialPosts.shares}), 0)`.as("total_shares"),
    })
    .from(socialPosts)
    .where(and(gte(socialPosts.postedAt, startDate), lte(socialPosts.postedAt, endDate)));

  const totalEng =
    Number(result.totalLikes) +
    Number(result.totalComments) +
    Number(result.totalSaves) +
    Number(result.totalShares);
  const totalReach = Number(result.totalReach);

  return {
    totalPosts: Number(result.totalPosts),
    totalReach,
    totalImpressions: Number(result.totalImpressions),
    totalLikes: Number(result.totalLikes),
    totalComments: Number(result.totalComments),
    totalSaves: Number(result.totalSaves),
    totalShares: Number(result.totalShares),
    avgEngagementRate: totalReach > 0 ? (totalEng / totalReach) * 100 : null,
    avgSaveRate: totalReach > 0 ? (Number(result.totalSaves) / totalReach) * 100 : null,
  };
}
