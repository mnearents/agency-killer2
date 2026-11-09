/**
 * Peer accounts — what is working elsewhere in the niche.
 *
 * Instagram shows another account's followers and its posts' likes, comments
 * and reel views, nothing more. So a peer's post is read against THAT
 * ACCOUNT'S OWN usual, the way Tara's are against hers: the question is what
 * broke out for them, not how big they are. Reels are judged on views,
 * everything else on likes plus comments.
 *
 * Giveaways are named and kept out of the usual: "comment to win" fills the
 * comments with entries, which says nothing about the content.
 *
 * Pure — no database, no clock.
 */

import { SETTLE_HOURS, BASELINE_DAYS, MIN_BASELINE, type FormatGroup, type ReviewPostAnalysis, type ReviewPostVisual, type Verdict } from "./review";

export interface PeerPost {
  id: string;
  username: string;
  caption: string | null;
  format: FormatGroup;
  permalink: string | null;
  thumbnailUrl: string | null;
  postedAt: Date;
  likeCount: number | null;
  commentsCount: number | null;
  /** Reels only. */
  viewCount: number | null;
  analysis: ReviewPostAnalysis | null;
  visual?: ReviewPostVisual | null;
}

export interface PeerDay {
  day: string;
  name: string | null;
  followersCount: number;
  mediaCount: number;
}

const GIVEAWAY = /\bgiveaway\b|\bto (enter|win)\b|\bwinner\b|\bcomment\b[^.!?\n]{0,40}\bwin\b/i;

export function isGiveaway(caption: string | null): boolean {
  return caption !== null && GIVEAWAY.test(caption);
}

type PeerMeasure = "views" | "engagement";

function measure(p: PeerPost): { measure: PeerMeasure; value: number | null } {
  if (p.format === "reel") return { measure: "views", value: p.viewCount };
  if (p.likeCount === null && p.commentsCount === null) return { measure: "engagement", value: null };
  return { measure: "engagement", value: (p.likeCount ?? 0) + (p.commentsCount ?? 0) };
}

const settled = (p: PeerPost, now: Date) => now.getTime() - p.postedAt.getTime() >= SETTLE_HOURS * 3_600_000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type PeerBaselines = Map<string, { measure: PeerMeasure; median: number | null; n: number }>;

/** Each account's usual per format, keyed `username:format`. */
export function buildPeerBaselines(posts: PeerPost[], now: Date): PeerBaselines {
  const from = now.getTime() - BASELINE_DAYS * 86_400_000;
  const groups = new Map<string, { measure: PeerMeasure; values: number[] }>();
  for (const p of posts) {
    if (p.postedAt.getTime() < from || !settled(p, now) || isGiveaway(p.caption)) continue;
    const m = measure(p);
    if (m.value === null) continue;
    const key = `${p.username}:${p.format}`;
    const g = groups.get(key) ?? { measure: m.measure, values: [] };
    g.values.push(m.value);
    groups.set(key, g);
  }
  return new Map([...groups].map(([k, g]) => [k, { measure: g.measure, median: median(g.values), n: g.values.length }]));
}

export interface PeerPostScore {
  judgedOn: PeerMeasure;
  value: number | null;
  /** A multiple of the account's own usual for the format. */
  vsUsual: number | null;
  verdict: Verdict;
  giveaway: boolean;
}

export function scorePeerPost(p: PeerPost, baselines: PeerBaselines, now: Date): PeerPostScore {
  const m = measure(p);
  const giveaway = isGiveaway(p.caption);
  const base = { judgedOn: m.measure, value: m.value, giveaway };
  if (m.value === null) return { ...base, vsUsual: null, verdict: "not-measured" };
  if (!settled(p, now)) return { ...base, vsUsual: null, verdict: "settling" };
  const b = baselines.get(`${p.username}:${p.format}`);
  if (!b || b.n < MIN_BASELINE || !b.median) return { ...base, vsUsual: null, verdict: "not-enough-history" };
  const vsUsual = Math.round((m.value / b.median) * 100) / 100;
  const verdict: Verdict = vsUsual >= 3 ? "breakout" : vsUsual >= 1.25 ? "above" : vsUsual <= 0.75 ? "below" : "typical";
  return { ...base, vsUsual, verdict };
}

const STANDOUT_DAYS = 30;

/**
 * One peer for the weekly review: followers, the week's posts, standouts of
 * the last 30 days (above its usual, best first), how often it posts each
 * format, and its usual.
 */
export function summarisePeer(username: string, allPosts: PeerPost[], days: PeerDay[], weekStart: string, weekEnd: string, now: Date) {
  const posts = allPosts.filter((p) => p.username === username);
  const baselines = buildPeerBaselines(posts, now);
  const describe = (p: PeerPost) => {
    const s = scorePeerPost(p, baselines, now);
    return {
      id: p.id,
      postedAt: p.postedAt.toISOString(),
      format: p.format,
      permalink: p.permalink,
      caption: p.caption ? p.caption.slice(0, 300) : null,
      likes: p.likeCount,
      comments: p.commentsCount,
      views: p.viewCount,
      hook: p.analysis?.hook ?? null,
      hookType: p.analysis?.hookType ?? null,
      approach: p.analysis?.approach ?? null,
      topic: p.analysis?.topic ?? null,
      audience: p.analysis?.audience ?? null,
      visual: p.visual
        ? { looked: p.visual.basis, type: p.visual.visualType, onScreenText: p.visual.onScreenText ?? [], visualHook: p.visual.visualHook, productVisible: p.visual.productVisible, handDrawn: p.visual.handDrawn, emotion: p.visual.emotion ?? null, summary: p.visual.summary ?? null }
        : null,
      ...s,
    };
  };

  const inWeek = posts
    .filter((p) => { const d = p.postedAt.toISOString().slice(0, 10); return d >= weekStart && d <= weekEnd; })
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())
    .map(describe);
  const recentFrom = now.getTime() - STANDOUT_DAYS * 86_400_000;
  const recent = posts.filter((p) => p.postedAt.getTime() >= recentFrom);
  const standouts = recent
    .map(describe)
    .filter((p) => p.verdict === "breakout" || p.verdict === "above")
    .sort((a, b) => (b.vsUsual ?? 0) - (a.vsUsual ?? 0))
    .slice(0, 8);

  const perWeek: Record<string, number> = {};
  for (const p of recent) perWeek[p.format] = (perWeek[p.format] ?? 0) + 1;
  for (const k of Object.keys(perWeek)) perWeek[k] = Math.round((perWeek[k] / (STANDOUT_DAYS / 7)) * 10) / 10;

  const mine = days.filter((d) => d.day <= weekEnd).sort((a, b) => a.day.localeCompare(b.day));
  const latest = mine[mine.length - 1];
  const inWeekDays = mine.filter((d) => d.day >= weekStart);
  const first = inWeekDays[0];

  return {
    username,
    name: latest?.name ?? null,
    followers: latest
      ? { latest: latest.followersCount, latestOn: latest.day, changeInWeek: first && first.day !== latest.day ? latest.followersCount - first.followersCount : null }
      : null,
    postsInWeek: inWeek,
    standouts,
    postsPerWeekLast30Days: perWeek,
    giveawaysLast30Days: recent.filter((p) => isGiveaway(p.caption)).length,
    usual: [...baselines].map(([key, b]) => ({ format: key.split(":")[1], ...b })),
  };
}
