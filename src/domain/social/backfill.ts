/**
 * Social backfill — re-fetches insights for posts in the DB that
 * have 0 reach. Used to fix posts that were synced before the
 * correct IG metrics were configured.
 */

import type { InstagramApiClient } from "@/integrations/instagram-api";
import type { Db } from "@/db/client";
import { socialPosts } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";

export interface BackfillResult {
  checked: number;
  updated: number;
  failed: number;
  errors: string[];
}

export async function backfillSocialInsights(
  client: InstagramApiClient,
  db: Db
): Promise<BackfillResult> {
  // Find all posts with 0 reach (likely missing insights)
  const zeroPosts = await db
    .select({
      id: socialPosts.id,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
    })
    .from(socialPosts)
    .where(eq(socialPosts.reach, 0));

  console.log(`[backfill] Found ${zeroPosts.length} posts with 0 reach`);

  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const post of zeroPosts) {
    try {
      const insights = await client.getMediaInsights(
        post.id,
        post.mediaType
      );

      if (insights.reach > 0 || insights.saved > 0 || insights.totalInteractions > 0) {
        await db
          .update(socialPosts)
          .set({
            impressions: insights.impressions,
            reach: insights.reach,
            saved: insights.saved,
            shares: insights.shares,
            plays: insights.plays,
            totalInteractions: insights.totalInteractions,
            updatedAt: new Date(),
          })
          .where(eq(socialPosts.id, post.id));
        updated++;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      // Only log non-400 errors (400s are expected for stories, low-impression posts)
      if (!msg.includes("400")) {
        errors.push(`${post.id}: ${msg.slice(0, 100)}`);
      }
    }

    // Throttle
    await new Promise((resolve) => setTimeout(resolve, 500));

    if ((updated + failed) % 20 === 0) {
      console.log(`[backfill] Progress: ${updated + failed}/${zeroPosts.length} (${updated} updated, ${failed} failed)`);
    }
  }

  console.log(`[backfill] Done: ${updated} updated, ${failed} failed out of ${zeroPosts.length}`);

  return {
    checked: zeroPosts.length,
    updated,
    failed,
    errors,
  };
}
