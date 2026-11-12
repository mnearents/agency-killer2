/**
 * Reads and writes for the weekly organic social review: posts with what they
 * were, the account's days, and the saved reviews themselves.
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialAccountDays, socialLessonRuns, socialLessons, socialPeerDays, socialPeerPosts, socialPeers, socialPostAnalyses, socialPosts, socialPostVisuals, socialReviews, socialTargets } from "@/db/schema";
import { formatGroup, type AccountDayRow, type ReviewPost, type ReviewPostVisual, type TargetMetric } from "./review";
import type { PeerDay, PeerPost } from "./peers";
import type { LessonArea, LessonRow } from "./lessons";

/**
 * Posts since a date, newest first, each with its analysis. Stories are left
 * out: they expire from the API within a day, so they carry a reach and
 * little else, and the account's daily views by surface already count them.
 */
export async function getReviewPosts(db: Db, since: Date): Promise<ReviewPost[]> {
  const rows = await db
    .select({
      id: socialPosts.id,
      caption: socialPosts.caption,
      permalink: socialPosts.permalink,
      thumbnailUrl: socialPosts.thumbnailUrl,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      postedAt: socialPosts.postedAt,
      views: socialPosts.views,
      reach: socialPosts.reach,
      likes: socialPosts.likeCount,
      comments: socialPosts.commentsCount,
      saved: socialPosts.saved,
      shares: socialPosts.shares,
      reposts: socialPosts.reposts,
      follows: socialPosts.follows,
      profileVisits: socialPosts.profileVisits,
      avgWatchTimeMs: socialPosts.avgWatchTimeMs,
      durationMs: socialPosts.durationMs,
      insightsStatus: socialPosts.insightsStatus,
      openingWords: socialPosts.openingWords,
      postVisualStatus: socialPosts.visualStatus,
      analysisStatus: socialPostAnalyses.status,
      hook: socialPostAnalyses.hook,
      hookSource: socialPostAnalyses.hookSource,
      hookType: socialPostAnalyses.hookType,
      approach: socialPostAnalyses.approach,
      audience: socialPostAnalyses.audience,
      topic: socialPostAnalyses.topic,
      summary: socialPostAnalyses.summary,
      product: socialPostAnalyses.product,
      callToAction: socialPostAnalyses.callToAction,
      basis: socialPostAnalyses.basis,
      visualStatus: socialPostVisuals.status,
      vBasis: socialPostVisuals.basis,
      vType: socialPostVisuals.visualType,
      vHook: socialPostVisuals.visualHook,
      vFace: socialPostVisuals.faceInFirst2s,
      vProduct: socialPostVisuals.productVisible,
      vProductFirst: socialPostVisuals.productFirstSeen,
      vHandDrawn: socialPostVisuals.handDrawn,
      vAudio: socialPostVisuals.audio,
      vCuts: socialPostVisuals.cuts,
      vCutsPerMinute: socialPostVisuals.cutsPerMinute,
      vSummary: socialPostVisuals.summary,
      vText: socialPostVisuals.onScreenText,
      vFirstFrame: socialPostVisuals.firstFrame,
      vSetting: socialPostVisuals.setting,
      vEmotion: socialPostVisuals.emotion,
      vBranding: socialPostVisuals.branding,
      vHasSheet: sql<boolean>`${socialPostVisuals.contactSheet} IS NOT NULL`,
      vSource: socialPostVisuals.source,
      vSong: socialPostVisuals.songUsed,
      vAudioNote: socialPostVisuals.audioNote,
    })
    .from(socialPosts)
    .leftJoin(socialPostAnalyses, eq(socialPostAnalyses.postId, socialPosts.id))
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPosts.id))
    .where(and(gte(socialPosts.postedAt, since), sql`${socialPosts.mediaProductType} IS DISTINCT FROM 'STORY'`))
    .orderBy(desc(socialPosts.postedAt));

  return rows.map((r) => ({
    id: r.id,
    caption: r.caption,
    permalink: r.permalink,
    thumbnailUrl: r.thumbnailUrl,
    format: formatGroup(r.mediaType, r.mediaProductType),
    postedAt: r.postedAt,
    views: r.views,
    reach: r.reach,
    likes: r.likes,
    comments: r.comments,
    saved: r.saved,
    shares: r.shares,
    reposts: r.reposts,
    follows: r.follows,
    profileVisits: r.profileVisits,
    avgWatchTimeMs: r.avgWatchTimeMs,
    durationMs: r.durationMs,
    insightsStatus: r.insightsStatus,
    openingWords: r.openingWords,
    analysis: r.analysisStatus === "ok"
      ? {
          hook: r.hook, hookSource: r.hookSource, hookType: r.hookType, approach: r.approach, audience: r.audience,
          topic: r.topic, summary: r.summary, product: r.product, callToAction: r.callToAction, basis: r.basis,
        }
      : null,
    visual: toVisual(r),
    visualStatus: r.postVisualStatus,
  }));
}

type VisualColumns = {
  visualStatus: string | null; vBasis: string | null; vType: string | null; vHook: string | null; vFace: number | null;
  vProduct: number | null; vProductFirst: string | null; vHandDrawn: number | null; vAudio: string | null; vCuts: number | null;
  vCutsPerMinute: number | null; vSummary: string | null; vText: Array<{ at: string; text: string }> | null; vFirstFrame: string | null;
  vSetting: string | null; vEmotion: string | null; vBranding: number | null; vHasSheet: boolean | null;
  vSource: string | null; vSong: string | null; vAudioNote: string | null;
};

const asBool = (v: number | null) => (v === null ? null : v === 1);

/** A finished visual analysis, or null — an error or "nothing to see" is not one. */
function toVisual(r: VisualColumns): ReviewPostVisual | null {
  if (r.visualStatus !== "ok") return null;
  return {
    basis: r.vBasis, visualType: r.vType, visualHook: r.vHook, faceInFirst2s: asBool(r.vFace), productVisible: asBool(r.vProduct),
    productFirstSeen: r.vProductFirst, handDrawn: asBool(r.vHandDrawn), audio: r.vAudio, cuts: r.vCuts, cutsPerMinute: r.vCutsPerMinute,
    summary: r.vSummary, onScreenText: r.vText, firstFrame: r.vFirstFrame, setting: r.vSetting, emotion: r.vEmotion,
    branding: asBool(r.vBranding), hasContactSheet: r.vHasSheet === true,
    source: r.vSource, songUsed: r.vSong, audioNote: r.vAudioNote,
  };
}

/** Account days between two dates inclusive, oldest first. */
export async function getAccountDayRows(db: Db, from: string, to: string): Promise<AccountDayRow[]> {
  return db
    .select({
      day: socialAccountDays.day,
      followersCount: socialAccountDays.followersCount,
      follows: socialAccountDays.follows,
      unfollows: socialAccountDays.unfollows,
      reach: socialAccountDays.reach,
      reachFollowers: socialAccountDays.reachFollowers,
      reachNonFollowers: socialAccountDays.reachNonFollowers,
      views: socialAccountDays.views,
      viewsReel: socialAccountDays.viewsReel,
      viewsPost: socialAccountDays.viewsPost,
      viewsCarousel: socialAccountDays.viewsCarousel,
      viewsStory: socialAccountDays.viewsStory,
      viewsAd: socialAccountDays.viewsAd,
      profileViews: socialAccountDays.profileViews,
      accountsEngaged: socialAccountDays.accountsEngaged,
      insightsFetchedAt: socialAccountDays.insightsFetchedAt,
    })
    .from(socialAccountDays)
    .where(and(gte(socialAccountDays.day, from), lte(socialAccountDays.day, to)))
    .orderBy(socialAccountDays.day);
}

export type SocialReview = typeof socialReviews.$inferSelect;
export type NewSocialReview = Omit<typeof socialReviews.$inferInsert, "id" | "createdAt">;

export async function saveReview(db: Db, review: NewSocialReview): Promise<SocialReview> {
  const [saved] = await db.insert(socialReviews).values(review).returning();
  return saved;
}

/** The review to show: the newest written, whatever week it covers. */
export async function getLatestReview(db: Db): Promise<SocialReview | null> {
  const [row] = await db.select().from(socialReviews).orderBy(desc(socialReviews.weekStart), desc(socialReviews.createdAt)).limit(1);
  return row ?? null;
}

export async function getReview(db: Db, id: string): Promise<SocialReview | null> {
  const [row] = await db.select().from(socialReviews).where(eq(socialReviews.id, id)).limit(1);
  return row ?? null;
}

/**
 * One review per week — the newest written for it — newest week first. A
 * rewritten week replaces its earlier version in the archive.
 */
export async function listReviews(db: Db, limit = 52): Promise<Array<Pick<SocialReview, "id" | "weekStart" | "weekEnd" | "headline">>> {
  const rows = await db
    .selectDistinctOn([socialReviews.weekStart], {
      id: socialReviews.id,
      weekStart: socialReviews.weekStart,
      weekEnd: socialReviews.weekEnd,
      headline: socialReviews.headline,
    })
    .from(socialReviews)
    .orderBy(desc(socialReviews.weekStart), desc(socialReviews.createdAt))
    .limit(limit);
  return rows;
}

export type PeerPurpose = "peer" | "teacher";

export interface Peer {
  username: string;
  /** peer: benchmarked for ideas. teacher: read for its advice. */
  purpose: PeerPurpose;
  notes: string | null;
  active: boolean;
}

/** Peer accounts — active only unless asked. */
export async function getPeers(db: Db, includeInactive = false): Promise<Peer[]> {
  const rows = await db
    .select({ username: socialPeers.username, purpose: socialPeers.purpose, notes: socialPeers.notes, active: socialPeers.active })
    .from(socialPeers)
    .where(includeInactive ? undefined : eq(socialPeers.active, 1))
    .orderBy(socialPeers.username);
  return rows.map((r) => ({ ...r, purpose: r.purpose as PeerPurpose, active: r.active === 1 }));
}

/** Start or stop watching an account. Stopping keeps its history. */
export async function setPeer(db: Db, peer: { username: string; active: boolean; purpose?: PeerPurpose; notes?: string; addedBy: string | null }): Promise<Peer> {
  const values = {
    active: peer.active ? 1 : 0,
    updatedAt: new Date(),
    ...(peer.notes !== undefined ? { notes: peer.notes } : {}),
    ...(peer.purpose !== undefined ? { purpose: peer.purpose } : {}),
  };
  const [row] = await db
    .insert(socialPeers)
    .values({ username: peer.username, addedBy: peer.addedBy, ...values })
    .onConflictDoUpdate({ target: socialPeers.username, set: values })
    .returning({ username: socialPeers.username, purpose: socialPeers.purpose, notes: socialPeers.notes, active: socialPeers.active });
  return { ...row, purpose: row.purpose as PeerPurpose, active: row.active === 1 };
}

/** Peer posts since a date, newest first, each with what it was. */
export async function getPeerPosts(db: Db, since: Date): Promise<PeerPost[]> {
  const rows = await db
    .select({
      id: socialPeerPosts.id,
      username: socialPeerPosts.username,
      caption: socialPeerPosts.caption,
      mediaType: socialPeerPosts.mediaType,
      mediaProductType: socialPeerPosts.mediaProductType,
      permalink: socialPeerPosts.permalink,
      thumbnailUrl: socialPeerPosts.thumbnailUrl,
      postedAt: socialPeerPosts.postedAt,
      likeCount: socialPeerPosts.likeCount,
      commentsCount: socialPeerPosts.commentsCount,
      viewCount: socialPeerPosts.viewCount,
      openingWords: socialPeerPosts.openingWords,
      purpose: socialPeers.purpose,
      analysisStatus: socialPostAnalyses.status,
      hook: socialPostAnalyses.hook,
      hookType: socialPostAnalyses.hookType,
      approach: socialPostAnalyses.approach,
      audience: socialPostAnalyses.audience,
      topic: socialPostAnalyses.topic,
      visualStatus: socialPostVisuals.status,
      vBasis: socialPostVisuals.basis,
      vType: socialPostVisuals.visualType,
      vHook: socialPostVisuals.visualHook,
      vFace: socialPostVisuals.faceInFirst2s,
      vProduct: socialPostVisuals.productVisible,
      vProductFirst: socialPostVisuals.productFirstSeen,
      vHandDrawn: socialPostVisuals.handDrawn,
      vAudio: socialPostVisuals.audio,
      vCuts: socialPostVisuals.cuts,
      vCutsPerMinute: socialPostVisuals.cutsPerMinute,
      vSummary: socialPostVisuals.summary,
      vText: socialPostVisuals.onScreenText,
      vFirstFrame: socialPostVisuals.firstFrame,
      vSetting: socialPostVisuals.setting,
      vEmotion: socialPostVisuals.emotion,
      vBranding: socialPostVisuals.branding,
      vHasSheet: sql<boolean>`${socialPostVisuals.contactSheet} IS NOT NULL`,
      vSource: socialPostVisuals.source,
      vSong: socialPostVisuals.songUsed,
      vAudioNote: socialPostVisuals.audioNote,
    })
    .from(socialPeerPosts)
    .leftJoin(socialPostAnalyses, eq(socialPostAnalyses.postId, socialPeerPosts.id))
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPeerPosts.id))
    .leftJoin(socialPeers, eq(socialPeers.username, socialPeerPosts.username))
    .where(gte(socialPeerPosts.postedAt, since))
    .orderBy(desc(socialPeerPosts.postedAt));
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    caption: r.caption,
    format: formatGroup(r.mediaType, r.mediaProductType),
    permalink: r.permalink,
    thumbnailUrl: r.thumbnailUrl,
    postedAt: r.postedAt,
    likeCount: r.likeCount,
    commentsCount: r.commentsCount,
    viewCount: r.viewCount,
    analysis: r.analysisStatus === "ok"
      ? { hook: r.hook, hookType: r.hookType, approach: r.approach, audience: r.audience, topic: r.topic }
      : null,
    visual: toVisual(r),
    openingWords: r.openingWords,
    purpose: (r.purpose ?? "peer") as PeerPurpose,
  }));
}

/** Lessons from teacher accounts, newest post first, optionally one account or area. */
export async function getLessons(db: Db, filter: { since: Date; username?: string; area?: LessonArea }): Promise<LessonRow[]> {
  const rows = await db
    .select({
      postId: socialLessons.postId,
      username: socialLessons.username,
      area: socialLessons.area,
      principle: socialLessons.principle,
      howToApply: socialLessons.howToApply,
      kind: socialLessons.kind,
      quote: socialLessons.quote,
      permalink: socialPeerPosts.permalink,
      postedAt: socialPeerPosts.postedAt,
      basis: socialLessonRuns.basis,
    })
    .from(socialLessons)
    .innerJoin(socialPeerPosts, eq(socialPeerPosts.id, socialLessons.postId))
    .leftJoin(socialLessonRuns, eq(socialLessonRuns.postId, socialLessons.postId))
    .where(and(
      gte(socialPeerPosts.postedAt, filter.since),
      filter.username !== undefined ? eq(socialLessons.username, filter.username) : undefined,
      filter.area !== undefined ? eq(socialLessons.area, filter.area) : undefined,
    ))
    .orderBy(desc(socialPeerPosts.postedAt));
  return rows.map((r) => ({ ...r, area: r.area as LessonArea, kind: r.kind as LessonRow["kind"] }));
}

/** Per teacher account: posts held, read for lessons, and that taught something. */
export async function getLessonCoverage(db: Db): Promise<Array<{ username: string; posts: number; read: number; withLessons: number }>> {
  const rows = await db
    .select({
      username: socialPeerPosts.username,
      posts: sql<number>`count(*)::int`,
      read: sql<number>`count(*) FILTER (WHERE ${socialLessonRuns.status} IN ('ok', 'none'))::int`,
      withLessons: sql<number>`count(*) FILTER (WHERE ${socialLessonRuns.status} = 'ok')::int`,
    })
    .from(socialPeerPosts)
    .innerJoin(socialPeers, and(eq(socialPeers.username, socialPeerPosts.username), eq(socialPeers.purpose, "teacher")))
    .leftJoin(socialLessonRuns, eq(socialLessonRuns.postId, socialPeerPosts.id))
    .groupBy(socialPeerPosts.username);
  return rows.map((r) => ({ username: r.username, posts: Number(r.posts), read: Number(r.read), withLessons: Number(r.withLessons) }));
}

/** Peer follower readings between two dates inclusive. */
export async function getPeerDays(db: Db, from: string, to: string): Promise<Array<PeerDay & { username: string }>> {
  return db
    .select({
      username: socialPeerDays.username,
      day: socialPeerDays.day,
      name: socialPeerDays.name,
      followersCount: socialPeerDays.followersCount,
      mediaCount: socialPeerDays.mediaCount,
    })
    .from(socialPeerDays)
    .where(and(gte(socialPeerDays.day, from), lte(socialPeerDays.day, to)))
    .orderBy(socialPeerDays.day);
}

export interface SocialTarget {
  metric: TargetMetric;
  value: number | null;
  targetDate: string | null;
  notes: string | null;
  setAt: Date;
  requestedBy: string | null;
}

/** The current target per metric — the newest row; a null value is a cleared one. */
export async function getTargets(db: Db): Promise<SocialTarget[]> {
  const rows = await db
    .selectDistinctOn([socialTargets.metric], {
      metric: socialTargets.metric, value: socialTargets.value, targetDate: socialTargets.targetDate,
      notes: socialTargets.notes, setAt: socialTargets.createdAt, requestedBy: socialTargets.requestedBy,
    })
    .from(socialTargets)
    .orderBy(socialTargets.metric, desc(socialTargets.createdAt));
  return rows.map((r) => ({ ...r, metric: r.metric as TargetMetric }));
}

export async function recordTarget(db: Db, t: { metric: TargetMetric; value: number | null; targetDate: string | null; notes: string | null; requestedBy: string | null }): Promise<void> {
  await db.insert(socialTargets).values({ ...t, author: "claude" });
}

/** A reel's contact sheet, for the dashboard. */
export async function getContactSheet(db: Db, postId: string): Promise<Buffer | null> {
  const [row] = await db.select({ sheet: socialPostVisuals.contactSheet }).from(socialPostVisuals).where(eq(socialPostVisuals.postId, postId)).limit(1);
  return row?.sheet ?? null;
}

export interface UploadableReel {
  id: string;
  postedAt: Date;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  views: number | null;
  visualStatus: string | null;
  /** Set once uploaded and analysed. */
  upload: { analysedAt: Date; songUsed: string | null; visualHook: string | null; summary: string | null } | null;
}

/**
 * Reels for the upload page: those Instagram withheld the video of, waiting,
 * and those already uploaded, newest first, since a date.
 */
export async function getUploadableReels(db: Db, since: Date): Promise<UploadableReel[]> {
  const rows = await db
    .select({
      id: socialPosts.id,
      postedAt: socialPosts.postedAt,
      caption: socialPosts.caption,
      permalink: socialPosts.permalink,
      thumbnailUrl: socialPosts.thumbnailUrl,
      views: socialPosts.views,
      visualStatus: socialPosts.visualStatus,
      source: socialPostVisuals.source,
      visualOk: socialPostVisuals.status,
      analysedAt: socialPostVisuals.analysedAt,
      songUsed: socialPostVisuals.songUsed,
      visualHook: socialPostVisuals.visualHook,
      summary: socialPostVisuals.summary,
    })
    .from(socialPosts)
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPosts.id))
    .where(and(
      gte(socialPosts.postedAt, since),
      sql`(${socialPosts.visualStatus} = 'cover_only' OR ${socialPostVisuals.source} = 'manual_upload')`,
    ))
    .orderBy(desc(socialPosts.postedAt));
  return rows.map((r) => ({
    id: r.id,
    postedAt: r.postedAt,
    caption: r.caption,
    permalink: r.permalink,
    thumbnailUrl: r.thumbnailUrl,
    views: r.views,
    visualStatus: r.visualStatus,
    upload: r.source === "manual_upload" && r.visualOk === "ok" && r.analysedAt
      ? { analysedAt: r.analysedAt, songUsed: r.songUsed, visualHook: r.visualHook, summary: r.summary }
      : null,
  }));
}
