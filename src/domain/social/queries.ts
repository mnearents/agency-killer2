/**
 * Social post database queries — reads from Postgres for the
 * metrics and analysis modules.
 */

import { gte, lte, and, desc, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialPosts } from "@/db/schema";
import type { PostRow } from "./metrics";

export interface SocialPostRecord {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  permalink: string | null;
  likeCount: number;
  commentsCount: number;
  impressions: number;
  reach: number;
  saved: number;
  shares: number;
  plays: number;
  totalInteractions: number;
  postedAt: Date;
}

/**
 * Get all posts within a date range, ordered by posted_at descending.
 */
export async function getPostsByDateRange(
  db: Db,
  startDate: Date,
  endDate: Date
): Promise<SocialPostRecord[]> {
  return db
    .select({
      id: socialPosts.id,
      caption: socialPosts.caption,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      permalink: socialPosts.permalink,
      likeCount: socialPosts.likeCount,
      commentsCount: socialPosts.commentsCount,
      impressions: socialPosts.impressions,
      reach: socialPosts.reach,
      saved: socialPosts.saved,
      shares: socialPosts.shares,
      plays: socialPosts.plays,
      totalInteractions: socialPosts.totalInteractions,
      postedAt: socialPosts.postedAt,
    })
    .from(socialPosts)
    .where(
      and(
        gte(socialPosts.postedAt, startDate),
        lte(socialPosts.postedAt, endDate)
      )
    )
    .orderBy(desc(socialPosts.postedAt));
}

/**
 * Convert a DB record to a PostRow for metrics computation.
 */
export function toPostRow(record: SocialPostRecord): PostRow {
  return {
    likeCount: record.likeCount,
    commentsCount: record.commentsCount,
    saved: record.saved,
    shares: record.shares,
    impressions: record.impressions,
    reach: record.reach,
    plays: record.plays,
    mediaType: record.mediaType,
    mediaProductType: record.mediaProductType,
  };
}

export interface SocialPostSummary {
  totalPosts: number;
  totalReach: number;
  totalImpressions: number;
  totalEngagements: number;
  avgEngagementRate: number | null;
}

/**
 * Get aggregate summary stats for a date range.
 */
export async function getPostSummary(
  db: Db,
  lookbackDays: number
): Promise<SocialPostSummary> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

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
    .where(gte(socialPosts.postedAt, startDate));

  const totalEngagements =
    Number(result.totalLikes) +
    Number(result.totalComments) +
    Number(result.totalSaves) +
    Number(result.totalShares);

  const totalReach = Number(result.totalReach);

  return {
    totalPosts: Number(result.totalPosts),
    totalReach,
    totalImpressions: Number(result.totalImpressions),
    totalEngagements,
    avgEngagementRate:
      totalReach > 0 ? (totalEngagements / totalReach) * 100 : null,
  };
}
