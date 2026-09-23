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
import {
  shouldAttemptTranscription,
  classifyTranscription,
  type TranscriptionStatus,
} from "./transcription";

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
  /** Transcriptions that were second or third attempts at a past failure. */
  retried: number;
  errors: string[];
}

/**
 * Sync recent Instagram posts.
 *
 * The default window is 20 posts plus whatever stories are live. At the
 * current posting rate — 55-56 reels a month — a daily run covers new content
 * several times over, and the previous default of 50 spent most of its calls
 * re-fetching insights for posts already stored.
 *
 * It is a ROLLING window, not a backfill: anything older than the newest 20 is
 * only in the database if a run caught it at the time. Pass a higher limit
 * explicitly to reach further back.
 *
 * Each post costs one insights call, throttled to ~2/second, against
 * Instagram's ~200/hour limit.
 */
export const DEFAULT_MEDIA_LIMIT = 20;

export async function syncSocialPosts(
  deps: SyncSocialDeps,
  limit = DEFAULT_MEDIA_LIMIT
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

  // Step 4: Transcribe video posts that still need it.
  //
  // Which posts those are is decided from `social_posts.transcription_status`,
  // not from whether a kb_documents row exists. The old dedupe stored a
  // placeholder saying "no transcript" so the next run would skip, which made
  // a transient failure permanent and identical to a genuinely silent video.
  let transcribed = 0;
  let retried = 0;
  if (deps.transcriber) {
    const videoMedia = mediaList.filter(
      (m) => m.media_url && (m.media_type === "VIDEO" || m.media_product_type === "REELS" || m.media_product_type === "STORY")
    );

    for (const media of videoMedia) {
      const [state] = await db
        .select({
          status: socialPosts.transcriptionStatus,
          attempts: socialPosts.transcriptionAttempts,
        })
        .from(socialPosts)
        .where(eq(socialPosts.id, media.id))
        .limit(1);

      const decision = shouldAttemptTranscription({
        status: (state?.status ?? null) as TranscriptionStatus | null,
        attempts: state?.attempts ?? 0,
      });
      if (!decision.attempt) continue;
      if (decision.reason === "retryable") retried++;

      const classified = await (async () => {
        try {
          return classifyTranscription(await deps.transcriber!.transcribe(media.media_url!));
        } catch (err) {
          return classifyTranscription(null, err);
        }
      })();

      // The outcome is recorded whatever it was, so the next run knows whether
      // to try again rather than inferring it from the absence of a document.
      await db
        .update(socialPosts)
        .set({
          transcriptionStatus: classified.status,
          transcriptionAttempts: (state?.attempts ?? 0) + 1,
          transcriptionAttemptedAt: syncedAt,
          updatedAt: new Date(),
        })
        .where(eq(socialPosts.id, media.id));

      if (classified.status !== "ok" || classified.text === null) {
        if (classified.detail) {
          console.log(`[sync:social] No transcript for ${media.id} (${classified.status}): ${classified.detail}`);
        }
        continue;
      }

      // Only a real transcript becomes a knowledge base document. A placeholder
      // is not knowledge: it was listed by kb_documents, counted against
      // embedding coverage, and could never be returned by a search.
      const caption = media.caption ? media.caption.slice(0, 100) : "untitled";
      const formatLabel = media.media_product_type === "REELS" ? "Reel"
        : media.media_product_type === "STORY" ? "Story"
        : "Video";
      const postedDate = new Date(media.timestamp).toISOString().split("T")[0];
      const content = `[${formatLabel} posted ${postedDate}]\nCaption: ${media.caption ?? "(none)"}\n\nTranscript:\n${classified.text}`;

      let embedding: number[] | null = null;
      if (deps.embeddingClient) {
        try {
          embedding = (await deps.embeddingClient.embed(content)).embedding;
        } catch (err) {
          // Stored unembedded and therefore unsearchable, which is worth
          // saying rather than swallowing.
          console.error(`[sync:social] Embedding failed for ${media.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        await db
          .insert(kbDocuments)
          .values({
            title: `${formatLabel}: ${caption} (${postedDate})`,
            content,
            category: "social-transcript",
            sourceFile: `ig:${media.id}`,
            contentHash: crypto.randomUUID(),
            chunkIndex: 0,
            totalChunks: 1,
            contextPrefix: `Instagram ${formatLabel} from ${postedDate}`,
            documentDate: new Date(media.timestamp),
            embedding,
          });
        transcribed++;
      } catch (err) {
        errors.push(`KB insert failed for ${media.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    posts: rows.length,
    insightsFetched,
    insightsFailed,
    transcribed,
    retried,
    errors,
  };
}
