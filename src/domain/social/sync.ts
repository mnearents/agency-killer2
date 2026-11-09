/**
 * Social sync — pulls organic Instagram posts and insights,
 * transforms them to DB rows, and upserts.
 *
 * Two-step fetch per post:
 * 1. Media list (lightweight — caption, type, likes, comments)
 * 2. Media insights (heavier — impressions, reach, saves, shares, plays)
 *
 * Insights can fail per-post (IG returns 400 for stories older than 24h,
 * or for posts with too few impressions). A failure keeps whatever numbers
 * are already held and says `failed` on a post never measured, so its zeros
 * are not read as a flop.
 *
 * After the posts, each run also:
 * 3. snapshots each measured post's numbers for the day, so the review can
 *    see how a post's life went, not only where it ended;
 * 4. reads the account — today's follower count, and the follows, unfollows,
 *    reach to non-followers and views of every complete day it lacks;
 * 5. transcribes videos (keeping length and the first three seconds' words);
 * 6. asks Claude what each post was — hook, hook type, topic, approach,
 *    audience — once its transcript, if it will have one, is in.
 */

import type { InstagramApiClient, IgMedia, IgMediaInsights } from "@/integrations/instagram-api";
import type { AssemblyAiClient, TranscriptResult } from "@/integrations/assemblyai";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { EmbeddingClient } from "@/integrations/openai";
import type { NewSocialPost } from "@/db/schema";
import type { Db } from "@/db/client";
import { socialPosts, kbDocuments, socialPostSnapshots, socialAccountDays, socialPostAnalyses } from "@/db/schema";
import { sql, eq, and, gte, desc, ne } from "drizzle-orm";
import {
  shouldAttemptTranscription,
  classifyTranscription,
  MAX_TRANSCRIPTION_ATTEMPTS,
  type TranscriptionStatus,
} from "./transcription";
import { accountDaysToFetch, openingWords } from "./review";
import {
  buildPostAnalysisPrompt,
  parsePostAnalysis,
  readyForAnalysis,
  shouldAnalysePost,
} from "./post-analysis";

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
    views: insights?.views ?? null,
    reposts: insights?.reposts ?? null,
    avgWatchTimeMs: insights?.avgWatchTimeMs ?? null,
    totalWatchTimeMs: insights?.totalWatchTimeMs ?? null,
    follows: insights?.follows ?? null,
    profileVisits: insights?.profileVisits ?? null,
    insightsStatus: insights ? "ok" : "failed",
    postedAt: new Date(media.timestamp),
    syncedAt,
  };
}

/**
 * What an upsert overwrites on a post already stored. A failed insights fetch
 * updates only what the media list itself carries, so the numbers last
 * measured — and the `ok` that says they were — survive the failure.
 */
export function postUpsertSet(insightsOk: boolean): Record<string, ReturnType<typeof sql>> {
  const media = {
    caption: sql`EXCLUDED.caption`,
    likeCount: sql`EXCLUDED.like_count`,
    commentsCount: sql`EXCLUDED.comments_count`,
    syncedAt: sql`EXCLUDED.synced_at`,
    updatedAt: sql`NOW()`,
  };
  if (!insightsOk) return media;
  return {
    ...media,
    impressions: sql`EXCLUDED.impressions`,
    reach: sql`EXCLUDED.reach`,
    saved: sql`EXCLUDED.saved`,
    shares: sql`EXCLUDED.shares`,
    plays: sql`EXCLUDED.plays`,
    totalInteractions: sql`EXCLUDED.total_interactions`,
    views: sql`EXCLUDED.views`,
    reposts: sql`EXCLUDED.reposts`,
    avgWatchTimeMs: sql`EXCLUDED.avg_watch_time_ms`,
    totalWatchTimeMs: sql`EXCLUDED.total_watch_time_ms`,
    follows: sql`EXCLUDED.follows`,
    profileVisits: sql`EXCLUDED.profile_visits`,
    insightsStatus: sql`EXCLUDED.insights_status`,
  };
}

/** Days of account insight kept filled. Instagram serves about a month. */
export const ACCOUNT_WINDOW_DAYS = 28;

/** Posts analysed per run — enough to clear a backfill within days. */
export const ANALYSE_PER_RUN = 30;

export interface SyncSocialDeps {
  client: InstagramApiClient;
  db: Db;
  igUserId: string;
  transcriber?: AssemblyAiClient;
  embeddingClient?: EmbeddingClient;
  /** Analyses what each post was. Without it, analysis reports itself unconfigured. */
  anthropic?: AnthropicClient;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncSocialResult {
  posts: number;
  insightsFetched: number;
  insightsFailed: number;
  transcribed: number;
  /** Transcriptions that were second or third attempts at a past failure. */
  retried: number;
  /** Posts whose day was snapshotted — measured posts only. */
  snapshots: number;
  /** Null when it could not be read; the reason is in `errors`. */
  followersCount: number | null;
  /** Complete account days read this run. */
  accountDays: number;
  /** False when no Anthropic client was given — distinct from nothing to analyse. */
  analysisConfigured: boolean;
  analysed: number;
  analysisFailed: number;
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
  const syncedAt = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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
      insights = await client.getMediaInsights(media.id, media.media_type, media.media_product_type);
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
    await sleep(500);
  }

  console.log(`[sync:social] Insights: ${insightsFetched} fetched, ${insightsFailed} failed. Upserting to DB...`);

  // Step 3: Upsert to DB, and snapshot each measured post's day.
  const capturedOn = syncedAt.toISOString().slice(0, 10);
  let snapshots = 0;
  for (const row of rows) {
    const ok = row.insightsStatus === "ok";
    await db
      .insert(socialPosts)
      .values(row)
      .onConflictDoUpdate({ target: socialPosts.id, set: postUpsertSet(ok) });

    if (!ok) continue;
    const snapshot = {
      postId: row.id,
      capturedOn,
      capturedAt: syncedAt,
      ageHours: Math.max(0, Math.floor((syncedAt.getTime() - row.postedAt.getTime()) / 3_600_000)),
      views: row.views ?? null,
      reach: row.reach ?? 0,
      likes: row.likeCount ?? 0,
      comments: row.commentsCount ?? 0,
      saved: row.saved ?? 0,
      shares: row.shares ?? 0,
      reposts: row.reposts ?? null,
      follows: row.follows ?? null,
      profileVisits: row.profileVisits ?? null,
      avgWatchTimeMs: row.avgWatchTimeMs ?? null,
      totalInteractions: row.totalInteractions ?? 0,
    };
    const { postId: _postId, capturedOn: _capturedOn, ...measures } = snapshot;
    await db
      .insert(socialPostSnapshots)
      .values(snapshot)
      .onConflictDoUpdate({ target: [socialPostSnapshots.postId, socialPostSnapshots.capturedOn], set: measures });
    snapshots++;
  }

  // The account. Each part reports its own failure and the rest carries on:
  // the posts above are already stored whatever happens here.
  const account = await syncAccount(deps, syncedAt, sleep, errors);

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

      let raw: TranscriptResult | null = null;
      const classified = await (async () => {
        try {
          raw = await deps.transcriber!.transcribe(media.media_url!);
          return classifyTranscription(raw);
        } catch (err) {
          return classifyTranscription(null, err);
        }
      })();
      const heard = raw as TranscriptResult | null;

      // The outcome is recorded whatever it was, so the next run knows whether
      // to try again rather than inferring it from the absence of a document.
      await db
        .update(socialPosts)
        .set({
          transcriptionStatus: classified.status,
          transcriptionAttempts: (state?.attempts ?? 0) + 1,
          transcriptionAttemptedAt: syncedAt,
          ...(classified.status === "ok"
            ? { durationMs: heard?.durationMs ?? null, openingWords: openingWords(heard?.words) }
            : {}),
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

  // Step 6: what each post was.
  const analysis = deps.anthropic
    ? await analysePosts(db, deps.anthropic, syncedAt, errors)
    : { analysed: 0, analysisFailed: 0 };

  return {
    posts: rows.length,
    insightsFetched,
    insightsFailed,
    transcribed,
    retried,
    snapshots,
    followersCount: account.followersCount,
    accountDays: account.days,
    analysisConfigured: deps.anthropic !== undefined,
    ...analysis,
    errors,
  };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Today's follower count, then every complete account day of the last four
 * weeks not yet held (and the last three again, which Instagram revises).
 * The follower count and a day's insight are written to the same row by
 * different runs, so each write sets only its own columns.
 */
async function syncAccount(
  deps: SyncSocialDeps,
  now: Date,
  sleep: (ms: number) => Promise<void>,
  errors: string[],
): Promise<{ followersCount: number | null; days: number }> {
  const { client, db, igUserId } = deps;
  const today = now.toISOString().slice(0, 10);

  let followersCount: number | null = null;
  try {
    followersCount = (await client.getAccountInfo(igUserId)).followers_count;
    const counted = { followersCount, followersCapturedAt: now };
    await db
      .insert(socialAccountDays)
      .values({ igUserId, day: today, ...counted })
      .onConflictDoUpdate({ target: [socialAccountDays.igUserId, socialAccountDays.day], set: counted });
  } catch (err) {
    errors.push(`Instagram follower count unavailable: ${errorText(err)}`);
  }

  const from = new Date(now.getTime() - ACCOUNT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const held = await db
    .select({ day: socialAccountDays.day })
    .from(socialAccountDays)
    .where(and(eq(socialAccountDays.igUserId, igUserId), gte(socialAccountDays.day, from), sql`${socialAccountDays.insightsFetchedAt} IS NOT NULL`));

  let days = 0;
  for (const day of accountDaysToFetch(new Set(held.map((h) => h.day)), today, ACCOUNT_WINDOW_DAYS)) {
    try {
      const insight = { ...(await client.getAccountDay(igUserId, day)), insightsFetchedAt: now };
      await db
        .insert(socialAccountDays)
        .values({ igUserId, day, ...insight })
        .onConflictDoUpdate({ target: [socialAccountDays.igUserId, socialAccountDays.day], set: insight });
      days++;
    } catch (err) {
      errors.push(`Instagram account day ${day} unavailable: ${errorText(err)}`);
    }
    await sleep(300);
  }
  return { followersCount, days };
}

/**
 * Asks Claude what each post was, newest first, ANALYSE_PER_RUN at a time.
 * A reel waits for its transcript; an unreadable answer is recorded as an
 * error and retried, never stored as an empty analysis.
 */
async function analysePosts(
  db: Db,
  anthropic: AnthropicClient,
  now: Date,
  errors: string[],
): Promise<{ analysed: number; analysisFailed: number }> {
  const candidates = await db
    .select({
      id: socialPosts.id,
      caption: socialPosts.caption,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      transcriptionStatus: socialPosts.transcriptionStatus,
      transcriptionAttempts: socialPosts.transcriptionAttempts,
      analysisStatus: socialPostAnalyses.status,
      analysisAttempts: socialPostAnalyses.attempts,
    })
    .from(socialPosts)
    .leftJoin(socialPostAnalyses, eq(socialPostAnalyses.postId, socialPosts.id))
    .where(and(sql`${socialPosts.mediaProductType} IS DISTINCT FROM 'STORY'`, sql`${socialPostAnalyses.status} IS DISTINCT FROM 'ok'`, ne(socialPosts.id, "")))
    .orderBy(desc(socialPosts.postedAt))
    .limit(ANALYSE_PER_RUN * 3);

  let analysed = 0;
  let analysisFailed = 0;
  let tried = 0;
  for (const post of candidates) {
    if (tried >= ANALYSE_PER_RUN) break;
    const prior = post.analysisStatus === null ? null : { status: post.analysisStatus, attempts: post.analysisAttempts ?? 0 };
    if (!shouldAnalysePost(prior)) continue;
    if (!readyForAnalysis({ ...post, transcriptionAttempts: post.transcriptionAttempts ?? 0 }, MAX_TRANSCRIPTION_ATTEMPTS)) continue;

    let transcript: string | null = null;
    if (post.transcriptionStatus === "ok") {
      const [doc] = await db
        .select({ content: kbDocuments.content })
        .from(kbDocuments)
        .where(and(eq(kbDocuments.sourceFile, `ig:${post.id}`), eq(kbDocuments.category, "social-transcript")))
        .limit(1);
      transcript = doc?.content?.split("\nTranscript:\n")[1] ?? null;
    }
    const format = post.mediaProductType === "REELS" ? "Reel" : post.mediaType === "CAROUSEL_ALBUM" ? "Carousel" : post.mediaType === "VIDEO" ? "Video" : "Image";
    const built = buildPostAnalysisPrompt({ format, caption: post.caption, transcript });
    if (built === null) continue;
    tried++;

    const attempts = (prior?.attempts ?? 0) + 1;
    let parsed = null;
    let detail: string | null = null;
    try {
      const result = await anthropic.generate(built.prompt, { maxTokens: 600, temperature: 0 });
      parsed = parsePostAnalysis(result.text, built.basis);
      if (parsed === null) detail = `unreadable answer: ${result.text.slice(0, 200)}`;
    } catch (err) {
      detail = errorText(err).slice(0, 300);
    }

    const row = parsed
      ? { postId: post.id, status: "ok", attempts, basis: built.basis, ...parsed, detail: null, analysedAt: now }
      : {
          postId: post.id, status: "error", attempts, basis: built.basis, summary: null, hook: null, hookSource: null, hookType: null,
          topic: null, approach: null, audience: null, product: null, callToAction: null, detail, analysedAt: now,
        };
    const { postId: _postId, ...set } = row;
    await db.insert(socialPostAnalyses).values(row).onConflictDoUpdate({ target: socialPostAnalyses.postId, set });
    if (parsed) analysed++;
    else {
      analysisFailed++;
      if (attempts >= 3) errors.push(`Post ${post.id} could not be analysed after ${attempts} attempts: ${detail}`);
    }
  }
  return { analysed, analysisFailed };
}
