/**
 * Reads and writes for the weekly organic social review: posts with what they
 * were, the account's days, and the saved reviews themselves.
 */

import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialAccountDays, socialPeerDays, socialPeerPosts, socialPeers, socialPostAnalyses, socialPosts, socialReviews } from "@/db/schema";
import { formatGroup, type AccountDayRow, type ReviewPost } from "./review";
import type { PeerDay, PeerPost } from "./peers";

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
    })
    .from(socialPosts)
    .leftJoin(socialPostAnalyses, eq(socialPostAnalyses.postId, socialPosts.id))
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
  }));
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

export interface Peer {
  username: string;
  notes: string | null;
  active: boolean;
}

/** Peer accounts — active only unless asked. */
export async function getPeers(db: Db, includeInactive = false): Promise<Peer[]> {
  const rows = await db
    .select({ username: socialPeers.username, notes: socialPeers.notes, active: socialPeers.active })
    .from(socialPeers)
    .where(includeInactive ? undefined : eq(socialPeers.active, 1))
    .orderBy(socialPeers.username);
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}

/** Start or stop watching an account. Stopping keeps its history. */
export async function setPeer(db: Db, peer: { username: string; active: boolean; notes?: string; addedBy: string | null }): Promise<Peer> {
  const values = { active: peer.active ? 1 : 0, updatedAt: new Date(), ...(peer.notes !== undefined ? { notes: peer.notes } : {}) };
  const [row] = await db
    .insert(socialPeers)
    .values({ username: peer.username, addedBy: peer.addedBy, ...values })
    .onConflictDoUpdate({ target: socialPeers.username, set: values })
    .returning({ username: socialPeers.username, notes: socialPeers.notes, active: socialPeers.active });
  return { ...row, active: row.active === 1 };
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
      analysisStatus: socialPostAnalyses.status,
      hook: socialPostAnalyses.hook,
      hookType: socialPostAnalyses.hookType,
      approach: socialPostAnalyses.approach,
      audience: socialPostAnalyses.audience,
      topic: socialPostAnalyses.topic,
    })
    .from(socialPeerPosts)
    .leftJoin(socialPostAnalyses, eq(socialPostAnalyses.postId, socialPeerPosts.id))
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
  }));
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
