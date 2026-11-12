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
 * 6. reads each tracked peer account (`social_peers`): followers and its
 *    newest posts' likes, comments and reel views;
 * 7. asks Claude what each post was — hook, hook type, topic, approach,
 *    audience — once its transcript, if it will have one, is in; a peer's
 *    post from its caption alone;
 * 8. asks Claude what each post SHOWS, from its frames, cover, slides or
 *    image (`visual-sync.ts`).
 */

import type { InstagramApiClient, IgMedia, IgMediaInsights } from "@/integrations/instagram-api";
import type { AssemblyAiClient, TranscriptResult } from "@/integrations/assemblyai";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { EmbeddingClient } from "@/integrations/openai";
import type { NewSocialPost } from "@/db/schema";
import type { Db } from "@/db/client";
import { socialPosts, kbDocuments, socialPostSnapshots, socialAccountDays, socialPostAnalyses, socialPeers, socialPeerDays, socialPeerPosts } from "@/db/schema";
import { sql, eq, and, gte, desc, ne } from "drizzle-orm";
import {
  shouldAttemptTranscription,
  classifyTranscription,
  MAX_TRANSCRIPTION_ATTEMPTS,
  type TranscriptionStatus,
} from "./transcription";
import { accountDaysToFetch, openingWords } from "./review";
import { syncVisuals, type VisualSyncDeps } from "./visual-sync";
import { extractLessons, type LessonSyncResult } from "./lesson-sync";
import { runReelDownloads, type ReelDownloadRun } from "./reel-backfill";
import type { ReelDownloaderClient } from "@/integrations/reel-downloader";
import type { DownloadLimits } from "./download-plan";
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
    // A video's media_url is the video file; an image's is its picture.
    thumbnailUrl: media.thumbnail_url ?? (media.media_type === "VIDEO" ? null : media.media_url ?? null),
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
    // Instagram leaves media_url off reels carrying licensed music.
    visualStatus: media.media_product_type === "REELS" && !media.media_url ? "cover_only" : null,
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
    // Instagram's links expire; the newest is the one that loads.
    thumbnailUrl: sql`EXCLUDED.thumbnail_url`,
    // `analyzed` is never undone: an uploaded reel still arrives without its
    // video on every later sync.
    visualStatus: sql`CASE WHEN "social_posts"."visual_status" = 'analyzed' THEN 'analyzed' ELSE COALESCE(EXCLUDED.visual_status, "social_posts"."visual_status") END`,
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

/** A peer's newest posts read each day: about seven weeks of Pippi Post. */
export const PEER_MEDIA_LIMIT = 50;

export interface SyncSocialDeps {
  client: InstagramApiClient;
  db: Db;
  igUserId: string;
  transcriber?: AssemblyAiClient;
  embeddingClient?: EmbeddingClient;
  /** Analyses what each post was. Without it, analysis reports itself unconfigured. */
  anthropic?: AnthropicClient;
  /** ffmpeg and downloads, for what each post shows. Needs `anthropic` too. */
  visuals?: Pick<VisualSyncDeps, "video" | "fetchMedia" | "writeTemp">;
  /**
   * The reel downloader (RapidAPI), for reels Instagram withholds. Given only
   * when automatic downloads are switched on; needs `visuals` and `anthropic`.
   */
  downloads?: { downloader: ReelDownloaderClient; limits: DownloadLimits };
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
  /** Peer accounts read and failed, and their posts stored. */
  peers: { read: number; failed: number; posts: number };
  /** False when no Anthropic client was given — distinct from nothing to analyse. */
  analysisConfigured: boolean;
  analysed: number;
  analysisFailed: number;
  /** What each post shows. `configured: false` without the video tools or Anthropic. */
  visuals: { configured: boolean; analysed: number; failed: number; unavailable: number; failures: Array<{ postId: string; detail: string }> };
  /** Reels fetched through the downloader. `configured: false` when automatic downloads are off. */
  downloads: { configured: boolean } & Pick<ReelDownloadRun, "calls" | "ok" | "failed" | "stopped" | "deferred">;
  /** What teacher accounts' posts teach. `configured: false` without Anthropic. */
  lessons: LessonSyncResult & { configured: boolean };
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

  // Step 6: the peer accounts.
  const peers = await syncPeers(deps, syncedAt, sleep, errors);

  // Step 7: what each post was — ours, then the peers'.
  let analysis = { analysed: 0, analysisFailed: 0 };
  if (deps.anthropic) {
    const own = await analysePosts(db, deps.anthropic, syncedAt, errors);
    const theirs = await analysePeerPosts(db, deps.anthropic, syncedAt, errors);
    analysis = { analysed: own.analysed + theirs.analysed, analysisFailed: own.analysisFailed + theirs.analysisFailed };
  }

  // Step 8: what each post shows.
  const visuals = deps.anthropic && deps.visuals
    ? { configured: true, ...(await syncVisuals({ db, client, anthropic: deps.anthropic, now: () => syncedAt, ...deps.visuals }, errors)) }
    : { configured: false, analysed: 0, failed: 0, unavailable: 0, failures: [] };

  // Step 8b: the reels Instagram withholds, fetched through the downloader —
  // before step 9, so a teacher reel's words are read for lessons this run.
  let downloads: SyncSocialResult["downloads"] = { configured: false, calls: 0, ok: 0, failed: 0, stopped: null, deferred: { own: 0, teacher: 0, peer: 0 } };
  if (deps.anthropic && deps.visuals && deps.downloads) {
    const run = await runReelDownloads({
      db, anthropic: deps.anthropic, video: deps.visuals.video, downloader: deps.downloads.downloader, limits: deps.downloads.limits,
      transcriber: deps.transcriber, embeddingClient: deps.embeddingClient, now: () => syncedAt, sleep,
    }, {});
    downloads = { configured: true, calls: run.calls, ok: run.ok, failed: run.failed, stopped: run.stopped, deferred: run.deferred };
    for (const r of run.results.filter((x) => x.outcome !== "ok")) {
      errors.push(`Reel download for ${r.account === "own" ? "Tara's" : `@${r.username}'s`} post ${r.postId} (${r.permalink}): ${r.outcome}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }

  // Step 9: what the teacher accounts' posts teach — after step 8 has read
  // their slides, whose text is most of what a carousel teaches.
  const lessons = deps.anthropic
    ? { configured: true, ...(await extractLessons({ db, anthropic: deps.anthropic, now: () => syncedAt }, { waitForVisuals: deps.visuals !== undefined }, errors)) }
    : { configured: false, extracted: 0, none: 0, failed: 0, lessons: 0 };

  return {
    posts: rows.length,
    insightsFetched,
    insightsFailed,
    transcribed,
    retried,
    snapshots,
    followersCount: account.followersCount,
    accountDays: account.days,
    peers,
    analysisConfigured: deps.anthropic !== undefined,
    ...analysis,
    visuals,
    downloads,
    lessons,
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
 * Each active peer: today's follower count and its newest posts. One call per
 * account; one that fails is named and the rest carry on.
 */
async function syncPeers(
  deps: SyncSocialDeps,
  now: Date,
  sleep: (ms: number) => Promise<void>,
  errors: string[],
): Promise<{ read: number; failed: number; posts: number }> {
  const { client, db, igUserId } = deps;
  const peers = await db.select({ username: socialPeers.username }).from(socialPeers).where(eq(socialPeers.active, 1));
  const out = { read: 0, failed: 0, posts: 0 };
  for (const { username } of peers) {
    try {
      const { profile, media } = await client.getPeerAccount(igUserId, username, PEER_MEDIA_LIMIT);
      const day = { name: profile.name, followersCount: profile.followersCount, mediaCount: profile.mediaCount, capturedAt: now };
      await db
        .insert(socialPeerDays)
        .values({ username, day: now.toISOString().slice(0, 10), ...day })
        .onConflictDoUpdate({ target: [socialPeerDays.username, socialPeerDays.day], set: day });
      for (const m of media) {
        const latest = {
          caption: m.caption,
          permalink: m.permalink,
          thumbnailUrl: m.thumbnailUrl,
          likeCount: m.likeCount,
          commentsCount: m.commentsCount,
          viewCount: m.viewCount,
          imageUrls: m.imageUrls,
          syncedAt: now,
        };
        await db
          .insert(socialPeerPosts)
          .values({ id: m.id, username, mediaType: m.mediaType, mediaProductType: m.mediaProductType, postedAt: new Date(m.timestamp), firstSeenAt: now, ...latest })
          .onConflictDoUpdate({ target: socialPeerPosts.id, set: latest });
        out.posts++;
      }
      out.read++;
    } catch (err) {
      out.failed++;
      errors.push(`Peer account @${username} unavailable: ${errorText(err)}`);
    }
    await sleep(500);
  }
  return out;
}

/** Peer posts analysed per run, from their captions. */
const PEER_ANALYSE_PER_RUN = 20;

/**
 * What each peer post was, read from its caption — Instagram does not give
 * another account's video, so there is no transcript to wait for. A reel Matt
 * uploaded a copy of has one, and is read from that.
 */
async function analysePeerPosts(
  db: Db,
  anthropic: AnthropicClient,
  now: Date,
  errors: string[],
): Promise<{ analysed: number; analysisFailed: number }> {
  const candidates = await db
    .select({
      id: socialPeerPosts.id,
      caption: socialPeerPosts.caption,
      mediaType: socialPeerPosts.mediaType,
      mediaProductType: socialPeerPosts.mediaProductType,
      transcript: socialPeerPosts.transcript,
      analysisStatus: socialPostAnalyses.status,
      analysisAttempts: socialPostAnalyses.attempts,
    })
    .from(socialPeerPosts)
    .leftJoin(socialPostAnalyses, eq(socialPostAnalyses.postId, socialPeerPosts.id))
    .where(sql`${socialPostAnalyses.status} IS DISTINCT FROM 'ok'`)
    .orderBy(desc(socialPeerPosts.postedAt))
    .limit(PEER_ANALYSE_PER_RUN * 3);
  return analyseCandidates(db, anthropic, now, errors, candidates.map((c) => ({ ...c, transcript: c.transcript ?? null })), PEER_ANALYSE_PER_RUN);
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

  const ready: AnalysisCandidate[] = [];
  for (const post of candidates) {
    if (ready.length >= ANALYSE_PER_RUN) break;
    if (!shouldAnalysePost(post.analysisStatus === null ? null : { status: post.analysisStatus, attempts: post.analysisAttempts ?? 0 })) continue;
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
    ready.push({ ...post, transcript });
  }
  return analyseCandidates(db, anthropic, now, errors, ready, ANALYSE_PER_RUN);
}

interface AnalysisCandidate {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  transcript: string | null;
  analysisStatus: string | null;
  analysisAttempts: number | null;
}

async function analyseCandidates(
  db: Db,
  anthropic: AnthropicClient,
  now: Date,
  errors: string[],
  candidates: AnalysisCandidate[],
  limit: number,
): Promise<{ analysed: number; analysisFailed: number }> {
  let analysed = 0;
  let analysisFailed = 0;
  let tried = 0;
  for (const post of candidates) {
    if (tried >= limit) break;
    const prior = post.analysisStatus === null ? null : { status: post.analysisStatus, attempts: post.analysisAttempts ?? 0 };
    if (!shouldAnalysePost(prior)) continue;

    const format = post.mediaProductType === "REELS" ? "Reel" : post.mediaType === "CAROUSEL_ALBUM" ? "Carousel" : post.mediaType === "VIDEO" ? "Video" : "Image";
    const built = buildPostAnalysisPrompt({ format, caption: post.caption, transcript: post.transcript });
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
