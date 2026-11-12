/**
 * Which reels the downloader (RapidAPI) fetches this run — pure.
 *
 * Tara's withheld reels come first and are never capped. Teachers' and
 * peers' each have a monthly cap; past it their reels stay queued for next
 * month (they are simply still eligible then), never dropped. Over all of it
 * sits the plan's monthly limit, and the quota the API itself last reported
 * — which counts calls made anywhere, the RapidAPI console included, so it
 * wins over this system's own count.
 */

export type DownloadAccount = "own" | "teacher" | "peer";

export interface DownloadCandidate {
  postId: string;
  account: DownloadAccount;
  /** The account's handle; null for Tara's. */
  username: string | null;
  permalink: string;
  postedAt: Date;
}

export interface DownloadLimits {
  /** Calls a month the RapidAPI plan allows — everything included. */
  plan: number;
  teacher: number;
  peer: number;
}

export type DownloadUsage = Record<DownloadAccount, number>;

export interface QuotaState {
  /** Calls left as of the last call, by the API's own count. */
  remaining: number | null;
  resetAt: Date | null;
}

/** A reel that failed this often is left for a manual upload. */
export const MAX_DOWNLOAD_ATTEMPTS = 3;

const DEFAULTS: DownloadLimits = { plan: 3, teacher: 60, peer: 40 };

/** The settings, from the worker's environment. The plan default is the free tier's. */
export function readDownloadLimits(env: Record<string, string | undefined>): DownloadLimits {
  const whole = (v: string | undefined, fallback: number) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : fallback);
  return {
    plan: whole(env.RAPIDAPI_MONTHLY_LIMIT, DEFAULTS.plan),
    teacher: whole(env.TEACHER_MONTHLY_CAP, DEFAULTS.teacher),
    peer: whole(env.PEER_MONTHLY_CAP, DEFAULTS.peer),
  };
}

export function eligibleAfterFailures<T extends { postId: string }>(candidates: T[], failures: Map<string, number>): T[] {
  return candidates.filter((c) => (failures.get(c.postId) ?? 0) < MAX_DOWNLOAD_ATTEMPTS);
}

export function planDownloads(input: {
  own: DownloadCandidate[];
  teachers: DownloadCandidate[];
  peers: DownloadCandidate[];
  usage: DownloadUsage;
  limits: DownloadLimits;
  quota: QuotaState;
  now: Date;
  max?: number;
}): { planned: DownloadCandidate[]; deferred: DownloadUsage; blocked: "plan-limit" | "quota-exhausted" | null } {
  const all = { own: input.own.length, teacher: input.teachers.length, peer: input.peers.length };
  const quotaLive = input.quota.remaining !== null && (input.quota.resetAt === null || input.quota.resetAt > input.now);
  if (quotaLive && input.quota.remaining! <= 0) return { planned: [], deferred: all, blocked: "quota-exhausted" };

  const used = input.usage.own + input.usage.teacher + input.usage.peer;
  let left = input.limits.plan - used;
  if (quotaLive) left = Math.min(left, input.quota.remaining!);
  if (input.max !== undefined) left = Math.min(left, input.max);
  if (left <= 0) return { planned: [], deferred: all, blocked: input.max === 0 ? null : "plan-limit" };

  const take = (list: DownloadCandidate[], cap: number) => {
    const n = Math.max(0, Math.min(list.length, cap, left));
    left -= n;
    return list.slice(0, n);
  };
  const own = take(input.own, Infinity);
  const teachers = take(input.teachers, input.limits.teacher - input.usage.teacher);
  const peers = take(input.peers, input.limits.peer - input.usage.peer);
  return {
    planned: [...own, ...teachers, ...peers],
    deferred: { own: all.own - own.length, teacher: all.teacher - teachers.length, peer: all.peer - peers.length },
    blocked: null,
  };
}
