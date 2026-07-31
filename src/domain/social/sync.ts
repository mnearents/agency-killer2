/**
 * Social sync — pulls organic Instagram posts and insights,
 * transforms them to DB rows, and upserts.
 *
 * Two-step fetch per post:
 * 1. Media list (lightweight — caption, type, likes, comments)
 * 2. Media insights (heavier — impressions, reach, saves, shares, plays)
 *
 * Insights can fail per-post (IG returns 400 for stories older than 24h,
 * or for posts with too few impressions). We degrade gracefully — store
 * the media data with zeroed insights.
 */

import type { InstagramApiClient, IgMedia, IgMediaInsights } from "@/integrations/instagram-api";
import type { NewSocialPost } from "@/db/schema";
import type { Db } from "@/db/client";
import { socialPosts } from "@/db/schema";
import { sql } from "drizzle-orm";

export interface TransformInput {
  media: IgMedia;
  insights: IgMediaInsights | null;
  igUserId: string;
  syncedAt: Date;
}

export function transformMediaToPost(input: TransformInput): NewSocialPost {
  const { media, insights, igUserId, syncedAt } = input;

  return {
    id: media.id,
    igUserId,
    caption: media.caption ?? null,
    mediaType: media.media_type,
    mediaProductType: media.media_product_type ?? null,
    permalink: media.permalink ?? null,
    thumbnailUrl: media.thumbnail_url ?? null,
    likeCount: media.like_count ?? 0,
    commentsCount: media.comments_count ?? 0,
    impressions: insights?.impressions ?? 0,
    reach: insights?.reach ?? 0,
    saved: insights?.saved ?? 0,
    shares: insights?.shares ?? 0,
    plays: insights?.plays ?? 0,
    totalInteractions: insights?.totalInteractions ?? 0,
    postedAt: new Date(media.timestamp),
    syncedAt,
  };
}

export interface SyncSocialDeps {
  client: InstagramApiClient;
  db: Db;
  igUserId: string;
}

export interface SyncSocialResult {
  posts: number;
  insightsFetched: number;
  insightsFailed: number;
  errors: string[];
}

export async function syncSocialPosts(
  deps: SyncSocialDeps,
  limit = 50
): Promise<SyncSocialResult> {
  const { client, db, igUserId } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];

  // Step 1: Fetch recent media
  const mediaList = await client.getRecentMedia(igUserId, limit);

  // Step 2: Fetch insights for each post
  let insightsFetched = 0;
  let insightsFailed = 0;
  const rows: NewSocialPost[] = [];

  for (const media of mediaList) {
    let insights: IgMediaInsights | null = null;
    try {
      insights = await client.getMediaInsights(media.id, media.media_type);
      insightsFetched++;
    } catch (err) {
      insightsFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't log every story/low-impression failure — it's expected
      if (!msg.includes("400")) {
        errors.push(`Insights failed for ${media.id}: ${msg}`);
      }
    }

    rows.push(transformMediaToPost({ media, insights, igUserId, syncedAt }));
  }

  // Step 3: Upsert to DB
  for (const row of rows) {
    await db
      .insert(socialPosts)
      .values(row)
      .onConflictDoUpdate({
        target: socialPosts.id,
        set: {
          caption: sql`EXCLUDED.caption`,
          likeCount: sql`EXCLUDED.like_count`,
          commentsCount: sql`EXCLUDED.comments_count`,
          impressions: sql`EXCLUDED.impressions`,
          reach: sql`EXCLUDED.reach`,
          saved: sql`EXCLUDED.saved`,
          shares: sql`EXCLUDED.shares`,
          plays: sql`EXCLUDED.plays`,
          totalInteractions: sql`EXCLUDED.total_interactions`,
          syncedAt: sql`EXCLUDED.synced_at`,
          updatedAt: sql`NOW()`,
        },
      });
  }

  return {
    posts: rows.length,
    insightsFetched,
    insightsFailed,
    errors,
  };
}
