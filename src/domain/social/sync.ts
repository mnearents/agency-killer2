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
import type { AssemblyAiClient } from "@/integrations/assemblyai";
import type { EmbeddingClient } from "@/integrations/openai";
import type { NewSocialPost } from "@/db/schema";
import type { Db } from "@/db/client";
import { socialPosts, kbDocuments } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

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
  transcriber?: AssemblyAiClient;
  embeddingClient?: EmbeddingClient;
}

export interface SyncSocialResult {
  posts: number;
  insightsFetched: number;
  insightsFailed: number;
  transcribed: number;
  errors: string[];
}

/**
 * Sync recent Instagram posts. Default limit is 50 (about 2 weeks
 * of posts for most accounts). For initial backfill, pass a higher
 * limit explicitly. Each post requires one API call for insights,
 * so 50 posts = ~50 API calls, well within IG's hourly rate limit.
 */
export async function syncSocialPosts(
  deps: SyncSocialDeps,
  limit = 50
): Promise<SyncSocialResult> {
  const { client, db, igUserId } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];

  // Step 1: Fetch recent media + stories
  console.log(`[sync:social] Fetching media for IG user ${igUserId}...`);
  const recentMedia = await client.getRecentMedia(igUserId, limit);
  console.log(`[sync:social] Got ${recentMedia.length} posts`);
  if (recentMedia.length > 0) {
    // Log first few posts for debugging
    for (const m of recentMedia.slice(0, 3)) {
      console.log(`[sync:social] Post ${m.id}: type=${m.media_type} product=${m.media_product_type ?? "?"} date=${m.timestamp} caption="${(m.caption ?? "").slice(0, 50)}"`);
    }
  }

  let stories: typeof recentMedia = [];
  try {
    stories = await client.getStories(igUserId);
    if (stories.length > 0) {
      console.log(`[sync:social] Got ${stories.length} active stories`);
    }
  } catch (err) {
    // Stories endpoint can fail if no stories are live — non-fatal
    console.log(`[sync:social] Stories fetch skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mediaList = [...recentMedia, ...stories];

  // Step 2: Fetch insights for each post
  // Rate limiting: Instagram Graph API allows ~200 calls/hour per user.
  // Pause briefly between requests to stay well under the limit.
  let insightsFetched = 0;
  let insightsFailed = 0;
  const rows: NewSocialPost[] = [];

  for (const media of mediaList) {
    let insights: IgMediaInsights | null = null;
    try {
      insights = await client.getMediaInsights(media.id, media.media_type);
      insightsFetched++;
      if (rows.length < 3) {
        console.log(`[sync:social] Insights for ${media.id}: reach=${insights.reach} saved=${insights.saved} shares=${insights.shares}`);
      }
    } catch (err) {
      insightsFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      if (rows.length < 3) {
        console.log(`[sync:social] Insights failed for ${media.id}: ${msg.slice(0, 150)}`);
      }
      if (!msg.includes("400")) {
        errors.push(`Insights failed for ${media.id}: ${msg}`);
      }
    }

    rows.push(transformMediaToPost({ media, insights, igUserId, syncedAt }));

    if (rows.length % 10 === 0) {
      console.log(`[sync:social] Progress: ${rows.length}/${mediaList.length} posts processed`);
    }

    // Throttle: ~2 requests/second to stay under IG rate limits
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[sync:social] Insights: ${insightsFetched} fetched, ${insightsFailed} failed. Upserting to DB...`);

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

  // Step 4: Transcribe new video posts (reels + stories with audio)
  let transcribed = 0;
  if (deps.transcriber) {
    const videoMedia = mediaList.filter(
      (m) => m.media_url && (m.media_type === "VIDEO" || m.media_product_type === "REELS" || m.media_product_type === "STORY")
    );

    for (const media of videoMedia) {
      // Skip if already transcribed (check KB by source_file = ig:media_id)
      const sourceKey = `ig:${media.id}`;
      const existing = await db
        .select({ id: kbDocuments.id })
        .from(kbDocuments)
        .where(eq(kbDocuments.sourceFile, sourceKey))
        .limit(1);

      if (existing.length > 0) continue;

      const caption = media.caption ? media.caption.slice(0, 100) : "untitled";
      const formatLabel = media.media_product_type === "REELS" ? "Reel"
        : media.media_product_type === "STORY" ? "Story"
        : "Video";
      const postedDate = new Date(media.timestamp).toISOString().split("T")[0];

      let transcriptText: string | null = null;
      try {
        const result = await deps.transcriber.transcribe(media.media_url!);
        if (result.status === "completed" && result.text && result.text.trim().length > 0) {
          transcriptText = result.text;
        } else {
          console.log(`[sync:social] Transcription returned no text for ${media.id} (status: ${result.status})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sync:social] Transcription failed for ${media.id}: ${msg.slice(0, 150)}`);
      }

      // Always store a KB doc (even without transcript) so we don't retry
      const content = transcriptText
        ? `[${formatLabel} posted ${postedDate}]\nCaption: ${media.caption ?? "(none)"}\n\nTranscript:\n${transcriptText}`
        : `[${formatLabel} posted ${postedDate}]\nCaption: ${media.caption ?? "(none)"}\n\n(No audio transcript available)`;

      const row = {
        title: `${formatLabel}: ${caption} (${postedDate})`,
        content,
        category: "social-transcript",
        sourceFile: sourceKey,
        contentHash: crypto.randomUUID(),
        chunkIndex: 0,
        totalChunks: 1,
        contextPrefix: `Instagram ${formatLabel} from ${postedDate}`,
        documentDate: new Date(media.timestamp),
        embedding: null as number[] | null,
      };

      // Embed if we have a real transcript
      if (transcriptText && deps.embeddingClient) {
        try {
          const embResult = await deps.embeddingClient.embed(content);
          row.embedding = embResult.embedding;
        } catch {
          // Non-fatal — stored without embedding
        }
      }

      try {
        await db.insert(kbDocuments).values(row);
        if (transcriptText) {
          transcribed++;
          console.log(`[sync:social] Transcribed ${formatLabel}: ${caption.slice(0, 50)}`);
        }
      } catch (err) {
        console.error(`[sync:social] Failed to store transcript for ${media.id}:`, err);
      }
    }

    if (transcribed > 0) {
      console.log(`[sync:social] Transcribed ${transcribed} new video posts`);
    }
  }

  return {
    posts: rows.length,
    insightsFetched,
    insightsFailed,
    transcribed,
    errors,
  };
}
