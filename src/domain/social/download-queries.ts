/**
 * The reel downloader's queue and its record of calls.
 *
 * Queued, oldest rule first:
 * - Tara's reels Instagram withheld (`visual_status = 'cover_only'`), any age;
 * - every reel tracked peers posted in the last 30 days, the ones furthest
 *   above their account's usual first — each is downloaded and transcribed.
 * A reel already seen through a manual upload or a download is not queued,
 * nor one that has failed three times (`MAX_DOWNLOAD_ATTEMPTS`). Teacher
 * videos are never queued: each is sent to the Slack bot and fetched then.
 */

import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialDownloads, socialPosts, socialPostVisuals } from "@/db/schema";
import { eligibleAfterFailures, type DownloadAccount, type DownloadCandidate, type DownloadUsage, type QuotaState } from "./download-plan";
import { peerReelsForUpload } from "./peers";
import { getPeerPosts } from "./review-queries";

const PEER_HISTORY_DAYS = 90;

/** Outcomes that count against a reel: what the reel itself caused. */
export const FAILED_OUTCOMES = ["api-error", "no-video", "bad-file", "analysis-failed"] as const;

export interface DownloadQueue {
  own: DownloadCandidate[];
  peers: DownloadCandidate[];
}

/** Each reel's failed downloads. */
export async function getDownloadFailures(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ postId: socialDownloads.postId, n: sql<number>`count(*)::int` })
    .from(socialDownloads)
    .where(inArray(socialDownloads.outcome, [...FAILED_OUTCOMES]))
    .groupBy(socialDownloads.postId);
  return new Map(rows.map((r) => [r.postId, Number(r.n)]));
}

export async function getDownloadQueue(db: Db, now: Date): Promise<DownloadQueue> {
  const [own, peerPosts, failures] = await Promise.all([
    db
      .select({ postId: socialPosts.id, permalink: socialPosts.permalink, postedAt: socialPosts.postedAt })
      .from(socialPosts)
      .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPosts.id))
      .where(and(eq(socialPosts.visualStatus, "cover_only"), isNotNull(socialPosts.permalink), sql`${socialPostVisuals.source} IS DISTINCT FROM 'manual_upload'`))
      .orderBy(desc(socialPosts.postedAt)),
    // 90 days so each account's usual can be judged; only the last 30 are queued.
    getPeerPosts(db, new Date(now.getTime() - PEER_HISTORY_DAYS * 86_400_000)),
    getDownloadFailures(db),
  ]);

  const peers = peerReelsForUpload(peerPosts, now).waiting
    .filter((p) => p.permalink !== null)
    .map((p): DownloadCandidate => ({ postId: p.id, account: "peer", username: p.username, permalink: p.permalink!, postedAt: p.postedAt }));

  return {
    own: eligibleAfterFailures(own.map((r): DownloadCandidate => ({ postId: r.postId, account: "own", username: null, permalink: r.permalink!, postedAt: r.postedAt })), failures),
    peers: eligibleAfterFailures(peers, failures),
  };
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface LastDownload {
  calledAt: Date;
  postId: string;
  account: DownloadAccount;
  username: string | null;
  outcome: string;
  detail: string | null;
}

/** Calls this calendar month by account, the quota the API last reported, and the last call. */
export async function getDownloadUsage(db: Db, now: Date): Promise<{ usage: DownloadUsage; quota: QuotaState & { limit: number | null }; last: LastDownload | null }> {
  const [counts, [last]] = await Promise.all([
    db
      .select({ account: socialDownloads.account, n: sql<number>`count(*)::int` })
      .from(socialDownloads)
      .where(gte(socialDownloads.calledAt, monthStart(now)))
      .groupBy(socialDownloads.account),
    db
      .select({
        calledAt: socialDownloads.calledAt, postId: socialDownloads.postId, account: socialDownloads.account, username: socialDownloads.username,
        outcome: socialDownloads.outcome, detail: socialDownloads.detail, rateLimit: socialDownloads.rateLimit,
        rateRemaining: socialDownloads.rateRemaining, rateResetAt: socialDownloads.rateResetAt,
      })
      .from(socialDownloads)
      .orderBy(desc(socialDownloads.calledAt))
      .limit(1),
  ]);
  const usage: DownloadUsage = { own: 0, teacher: 0, peer: 0 };
  for (const c of counts) if (c.account in usage) usage[c.account as DownloadAccount] = Number(c.n);
  return {
    usage,
    quota: { remaining: last?.rateRemaining ?? null, resetAt: last?.rateResetAt ?? null, limit: last?.rateLimit ?? null },
    last: last ? { calledAt: last.calledAt, postId: last.postId, account: last.account as DownloadAccount, username: last.username, outcome: last.outcome, detail: last.detail } : null,
  };
}

/** Downloads that worked and that failed since a date — for the weekly review. */
export async function getDownloadSummary(db: Db, since: Date): Promise<{ ok: number; failed: number; rateLimited: number }> {
  const rows = await db
    .select({ outcome: socialDownloads.outcome, n: sql<number>`count(*)::int` })
    .from(socialDownloads)
    .where(gte(socialDownloads.calledAt, since))
    .groupBy(socialDownloads.outcome);
  const count = (pred: (o: string) => boolean) => rows.filter((r) => pred(r.outcome)).reduce((a, r) => a + Number(r.n), 0);
  return {
    ok: count((o) => o === "ok"),
    failed: count((o) => (FAILED_OUTCOMES as readonly string[]).includes(o)),
    rateLimited: count((o) => o === "rate-limited"),
  };
}

/** Each reel's download attempts and its last failure, for the upload page. */
export async function getDownloadStatusByPost(db: Db): Promise<Map<string, { failures: number; lastDetail: string | null; lastAt: Date }>> {
  const rows = await db
    .select({ postId: socialDownloads.postId, outcome: socialDownloads.outcome, detail: socialDownloads.detail, calledAt: socialDownloads.calledAt })
    .from(socialDownloads)
    .where(inArray(socialDownloads.outcome, [...FAILED_OUTCOMES]))
    .orderBy(socialDownloads.calledAt);
  const out = new Map<string, { failures: number; lastDetail: string | null; lastAt: Date }>();
  for (const r of rows) {
    const prior = out.get(r.postId);
    out.set(r.postId, { failures: (prior?.failures ?? 0) + 1, lastDetail: r.detail, lastAt: r.calledAt });
  }
  return out;
}
