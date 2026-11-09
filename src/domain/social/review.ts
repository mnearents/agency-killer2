/**
 * The arithmetic behind the weekly organic social review.
 *
 * Every post is judged against Tara's OWN usual for that format — the median
 * of her settled posts over the last 90 days — never against other accounts.
 * A reel at 3x her usual views is a breakout for her account whatever a viral
 * account did that week, and that is the comparison that says what to repeat.
 *
 * Three rules keep the numbers honest:
 * - A post younger than SETTLE_HOURS is "settling", not judged: its numbers
 *   are a fraction of what they will be.
 * - Null is unmeasured, never zero. Views, shares and watch time were never
 *   requested before 2026-11-09; a post whose insights failed holds zeros.
 *   Neither is a flop, and neither enters a baseline.
 * - A baseline needs MIN_BASELINE posts and a pattern MIN_PATTERN_POSTS;
 *   below that the answer is "not enough history", not a comparison.
 *
 * Pure — no database, no clock (the caller passes `now`).
 */

import type { TranscriptWord } from "@/integrations/assemblyai";

export const SETTLE_HOURS = 48;
export const BASELINE_DAYS = 90;
export const MIN_BASELINE = 5;
export const MIN_PATTERN_POSTS = 3;
const OPENING_MS = 3000;

export type FormatGroup = "reel" | "carousel" | "image" | "video" | "story";

export interface ReviewPostAnalysis {
  hookType: string | null;
  approach: string | null;
  audience: string | null;
  topic: string | null;
  hook?: string | null;
  hookSource?: string | null;
  summary?: string | null;
  product?: string | null;
  callToAction?: string | null;
  basis?: string | null;
}

/** What a post shows, as far as the pattern counting needs it. */
export interface ReviewPostVisual {
  /** frames | cover | image | slides — what the analysis looked at. */
  basis: string | null;
  visualType: string | null;
  visualHook: string | null;
  faceInFirst2s: boolean | null;
  productVisible: boolean | null;
  handDrawn: boolean | null;
  audio: string | null;
  cutsPerMinute: number | null;
  summary?: string | null;
  onScreenText?: Array<{ at: string; text: string }> | null;
  firstFrame?: string | null;
  setting?: string | null;
  emotion?: string | null;
  branding?: boolean | null;
  productFirstSeen?: string | null;
  cuts?: number | null;
  hasContactSheet?: boolean;
}

export interface ReviewPost {
  id: string;
  caption: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  format: FormatGroup;
  postedAt: Date;
  views: number | null;
  reach: number;
  likes: number;
  comments: number;
  saved: number;
  shares: number;
  reposts: number | null;
  follows: number | null;
  profileVisits: number | null;
  avgWatchTimeMs: number | null;
  durationMs: number | null;
  insightsStatus: string | null;
  openingWords: string | null;
  analysis: ReviewPostAnalysis | null;
  visual?: ReviewPostVisual | null;
}

export function formatGroup(mediaType: string, mediaProductType: string | null): FormatGroup {
  if (mediaProductType === "REELS") return "reel";
  if (mediaProductType === "STORY") return "story";
  if (mediaType === "CAROUSEL_ALBUM") return "carousel";
  if (mediaType === "VIDEO") return "video";
  return "image";
}

const MEASURES = ["views", "reach", "engagementRate", "shareRate", "saveRate", "watchThrough", "avgWatchSeconds"] as const;
export type Measure = (typeof MEASURES)[number];

/**
 * A post's measures. Null wherever the input was not measured: a failed or
 * never-fetched post has none, and shares only exist on posts fetched since
 * views were (2026-11-09), so the share and engagement rates of older posts
 * are unknown rather than zero.
 */
export function measuresOf(p: ReviewPost): Record<Measure, number | null> {
  const measured = p.insightsStatus !== "failed" && p.reach > 0;
  const modern = measured && p.views !== null;
  return {
    views: modern ? p.views : null,
    reach: measured ? p.reach : null,
    engagementRate: modern ? (p.likes + p.comments + p.saved + p.shares) / p.reach : null,
    shareRate: modern ? p.shares / p.reach : null,
    saveRate: measured ? p.saved / p.reach : null,
    watchThrough: modern && p.avgWatchTimeMs !== null && p.durationMs ? p.avgWatchTimeMs / p.durationMs : null,
    avgWatchSeconds: modern && p.avgWatchTimeMs !== null ? p.avgWatchTimeMs / 1000 : null,
  };
}

export type Baseline = Record<Measure, { median: number | null; n: number }>;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const ageHours = (p: ReviewPost, now: Date) => (now.getTime() - p.postedAt.getTime()) / 3_600_000;
export const isSettled = (p: ReviewPost, now: Date) => ageHours(p, now) >= SETTLE_HOURS;

/** Her usual, per format: medians over settled, measured posts of the last 90 days. */
export function buildBaselines(posts: ReviewPost[], now: Date): Map<FormatGroup, Baseline> {
  const from = now.getTime() - BASELINE_DAYS * 86_400_000;
  const byFormat = new Map<FormatGroup, ReviewPost[]>();
  for (const p of posts) {
    if (p.postedAt.getTime() < from || !isSettled(p, now)) continue;
    byFormat.set(p.format, [...(byFormat.get(p.format) ?? []), p]);
  }
  const out = new Map<FormatGroup, Baseline>();
  for (const [format, group] of byFormat) {
    const all = group.map(measuresOf);
    const baseline = {} as Baseline;
    for (const m of MEASURES) {
      const values = all.map((x) => x[m]).filter((v): v is number => v !== null);
      baseline[m] = { median: median(values), n: values.length };
    }
    out.set(format, baseline);
  }
  return out;
}

export type Verdict = "breakout" | "above" | "typical" | "below" | "settling" | "not-enough-history" | "not-measured";

export interface PostScore {
  settled: boolean;
  ageHours: number;
  /** Each measure as a multiple of her usual for the format. 2 = twice usual. */
  vsUsual: Record<Measure, number | null>;
  /** Which measure the verdict was read from. */
  judgedOn: "views" | "reach" | null;
  verdict: Verdict;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function scorePost(p: ReviewPost, baselines: Map<FormatGroup, Baseline>, now: Date): PostScore {
  const mine = measuresOf(p);
  const usual = baselines.get(p.format);
  const vsUsual = {} as Record<Measure, number | null>;
  for (const m of MEASURES) {
    const b = usual?.[m];
    vsUsual[m] = mine[m] !== null && b && b.n >= MIN_BASELINE && b.median ? round2(mine[m]! / b.median) : null;
  }
  const settled = isSettled(p, now);
  const base = { settled, ageHours: Math.round(ageHours(p, now)), vsUsual };

  if (mine.reach === null) return { ...base, judgedOn: null, verdict: "not-measured" };
  if (!settled) return { ...base, judgedOn: null, verdict: "settling" };
  const judgedOn = vsUsual.views !== null ? "views" : vsUsual.reach !== null ? "reach" : null;
  if (judgedOn === null) return { ...base, judgedOn, verdict: "not-enough-history" };
  const r = vsUsual[judgedOn]!;
  const verdict: Verdict = r >= 3 ? "breakout" : r >= 1.25 ? "above" : r <= 0.75 ? "below" : "typical";
  return { ...base, judgedOn, verdict };
}

/** Cuts a minute: under 10 slow, under 25 medium, else fast. */
export function editPace(cutsPerMinute: number | null): string | null {
  if (cutsPerMinute === null) return null;
  return cutsPerMinute < 10 ? "slow" : cutsPerMinute < 25 ? "medium" : "fast";
}

export function lengthBucket(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  if (durationMs < 15_000) return "under 15s";
  if (durationMs < 30_000) return "15-30s";
  if (durationMs <= 60_000) return "30-60s";
  return "over 60s";
}

export interface Pattern {
  dimension:
    | "format" | "hookType" | "approach" | "audience" | "topic" | "length"
    | "visualType" | "onScreenHook" | "faceFirst2s" | "productVisible" | "handDrawn" | "audio" | "editPace";
  value: string;
  posts: number;
  /** Median of each post's views (else reach) as a multiple of her usual. */
  medianViewsVsUsual: number;
  medianShareRateVsUsual: number | null;
  medianWatchThroughVsUsual: number | null;
}

/**
 * Which kinds of post do better than her usual: over settled, scored posts,
 * grouped by format, hook type, approach, audience, topic and (for reels)
 * length. A group of fewer than MIN_PATTERN_POSTS is left out — two posts
 * are an anecdote, and reported as a pattern they steer a week of work.
 */
export function findPatterns(posts: ReviewPost[], baselines: Map<FormatGroup, Baseline>, now: Date): Pattern[] {
  const scored = posts
    .map((p) => ({ p, s: scorePost(p, baselines, now) }))
    .filter(({ s }) => s.judgedOn !== null);
  const groups = new Map<string, { dimension: Pattern["dimension"]; value: string; items: typeof scored }>();
  const add = (dimension: Pattern["dimension"], value: string | null | undefined, item: (typeof scored)[number]) => {
    if (!value) return;
    const key = `${dimension}\u0000${value}`;
    const g = groups.get(key) ?? { dimension, value, items: [] };
    g.items.push(item);
    groups.set(key, g);
  };
  for (const item of scored) {
    const a = item.p.analysis;
    add("format", item.p.format, item);
    add("hookType", a?.hookType, item);
    add("approach", a?.approach, item);
    add("audience", a?.audience, item);
    add("topic", a?.topic, item);
    if (item.p.format === "reel") add("length", lengthBucket(item.p.durationMs), item);

    const v = item.p.visual;
    if (v) {
      const yesNo = (b: boolean | null | undefined) => (b === true ? "yes" : b === false ? "no" : null);
      add("visualType", v.visualType, item);
      add("productVisible", yesNo(v.productVisible), item);
      add("handDrawn", yesNo(v.handDrawn), item);
      add("audio", v.audio, item);
      // Only frames show a reel's opening; a cover says nothing about it.
      if (v.basis === "frames") {
        add("onScreenHook", v.visualHook ? "yes" : "no", item);
        add("faceFirst2s", yesNo(v.faceInFirst2s), item);
        add("editPace", editPace(v.cutsPerMinute), item);
      } else if (v.basis === "image" || v.basis === "slides") {
        add("onScreenHook", v.visualHook ? "yes" : "no", item);
      }
    }
  }
  const med = (vals: Array<number | null>) => {
    const v = median(vals.filter((x): x is number => x !== null));
    return v === null ? null : round2(v);
  };
  return [...groups.values()]
    .filter((g) => g.items.length >= MIN_PATTERN_POSTS)
    .map((g) => ({
      dimension: g.dimension,
      value: g.value,
      posts: g.items.length,
      medianViewsVsUsual: med(g.items.map(({ s }) => s.vsUsual[s.judgedOn!]))!,
      medianShareRateVsUsual: med(g.items.map(({ s }) => s.vsUsual.shareRate)),
      medianWatchThroughVsUsual: med(g.items.map(({ s }) => s.vsUsual.watchThrough)),
    }))
    .sort((a, b) => b.medianViewsVsUsual - a.medianViewsVsUsual);
}

/** What is said in the first three seconds: the hook, when it is spoken. */
export function openingWords(words: TranscriptWord[] | undefined | null): string | null {
  const opening = (words ?? []).filter((w) => w.start < OPENING_MS).map((w) => w.text);
  return opening.length > 0 ? opening.join(" ") : null;
}

export interface AccountDayRow {
  day: string;
  followersCount: number | null;
  follows: number | null;
  unfollows: number | null;
  reach: number | null;
  reachFollowers: number | null;
  reachNonFollowers: number | null;
  views: number | null;
  viewsReel: number | null;
  viewsPost: number | null;
  viewsCarousel: number | null;
  viewsStory: number | null;
  viewsAd: number | null;
  profileViews: number | null;
  accountsEngaged: number | null;
  insightsFetchedAt: Date | null;
}

export interface AccountSummary {
  from: string;
  to: string;
  daysInRange: number;
  /** Days whose insight was read. Fewer than daysInRange makes every total partial. */
  daysMeasured: number;
  follows: number | null;
  unfollows: number | null;
  net: number | null;
  /** From follower counts read on days a sync ran; null until two exist. */
  followers: { first: number; firstOn: string; last: number; lastOn: string; change: number } | null;
  /** Daily reach summed: one person reached on three days counts three times. */
  reachSummed: number | null;
  /** Share of reach that was people not yet following — the raw material of growth. */
  nonFollowerReachShare: number | null;
  /** All views less those shown as ads. */
  organicViews: number | null;
  viewsBySurface: { reel: number | null; post: number | null; carousel: number | null; story: number | null; ad: number | null };
  profileViews: number | null;
}

export function summariseAccountDays(rows: AccountDayRow[], from: string, to: string): AccountSummary {
  const inRange = rows.filter((r) => r.day >= from && r.day <= to);
  const measured = inRange.filter((r) => r.insightsFetchedAt !== null);
  const sum = (key: keyof AccountDayRow): number | null => {
    const vals = measured.map((r) => r[key]).filter((v): v is number => typeof v === "number");
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const follows = sum("follows");
  const unfollows = sum("unfollows");
  const reachF = sum("reachFollowers");
  const reachNF = sum("reachNonFollowers");
  const views = sum("views");
  const ad = sum("viewsAd");
  const counts = inRange.filter((r) => r.followersCount !== null).sort((a, b) => a.day.localeCompare(b.day));
  const first = counts[0];
  const last = counts[counts.length - 1];

  return {
    from,
    to,
    daysInRange: Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1,
    daysMeasured: measured.length,
    follows,
    unfollows,
    net: follows !== null && unfollows !== null ? follows - unfollows : null,
    followers: first && last
      ? { first: first.followersCount!, firstOn: first.day, last: last.followersCount!, lastOn: last.day, change: last.followersCount! - first.followersCount! }
      : null,
    reachSummed: sum("reach"),
    nonFollowerReachShare: reachF !== null && reachNF !== null && reachF + reachNF > 0 ? reachNF / (reachF + reachNF) : null,
    organicViews: views !== null ? views - (ad ?? 0) : null,
    viewsBySurface: { reel: sum("viewsReel"), post: sum("viewsPost"), carousel: sum("viewsCarousel"), story: sum("viewsStory"), ad },
    profileViews: sum("profileViews"),
  };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * The account days a sync should read: every complete day of the last
 * `windowDays` not yet held, plus the last three again because Instagram
 * revises recent days. Today is never read — it is not over. Oldest first.
 */
export function accountDaysToFetch(held: Set<string>, today: string, windowDays: number): string[] {
  const days: string[] = [];
  for (let i = windowDays; i >= 1; i--) {
    const d = addDays(today, -i);
    if (i <= 3 || !held.has(d)) days.push(d);
  }
  return days;
}


export type TargetMetric = "followers" | "posts_per_week" | "reels_per_week";

export interface ScorecardRow {
  measure: TargetMetric;
  actual: number | null;
  /** For followers, where the straight line to the target says she should be. */
  target: number | null;
  status: "ahead" | "on-track" | "behind" | "no-target" | "not-enough-history";
  note: string | null;
}

/**
 * The week against its targets — arithmetic, so the review never estimates
 * it. Followers are paced in a straight line from the first follower reading
 * to the target date; posts and reels are counted in the week. A measure
 * without a target says so; it is never a lead over zero.
 */
export function buildScorecard(input: {
  readings: Array<{ day: string; followersCount: number | null }>;
  targets: Array<{ metric: string; value: number | null; targetDate: string | null }>;
  weekEnd: string;
  postsInWeek: { all: number; reels: number };
}): ScorecardRow[] {
  const target = (m: TargetMetric) => input.targets.find((t) => t.metric === m && t.value !== null) ?? null;
  const status = (actual: number, goal: number): ScorecardRow["status"] => (actual > goal ? "ahead" : actual === goal ? "on-track" : "behind");

  const counts = input.readings.filter((r) => r.followersCount !== null && r.day <= input.weekEnd).sort((a, b) => a.day.localeCompare(b.day));
  const first = counts[0];
  const last = counts[counts.length - 1];
  const ft = target("followers");
  let followers: ScorecardRow;
  if (!ft || !ft.targetDate) {
    followers = { measure: "followers", actual: last?.followersCount ?? null, target: null, status: "no-target", note: null };
  } else if (!first || first.day === last.day) {
    followers = { measure: "followers", actual: last?.followersCount ?? null, target: null, status: "not-enough-history", note: "Pace needs two follower readings." };
  } else {
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    const span = day(ft.targetDate) - day(first.day);
    const elapsed = day(last.day) - day(first.day);
    const pace = span > 0 ? Math.round(first.followersCount! + ((ft.value! - first.followersCount!) * Math.min(elapsed, span)) / span) : ft.value!;
    followers = {
      measure: "followers", actual: last.followersCount, target: pace, status: status(last.followersCount!, pace),
      note: `${ft.value!.toLocaleString("en-US")} by ${ft.targetDate}, in a straight line from ${first.followersCount!.toLocaleString("en-US")} on ${first.day}`,
    };
  }

  const weekly = (m: "posts_per_week" | "reels_per_week", actual: number): ScorecardRow => {
    const t = target(m);
    return t ? { measure: m, actual, target: t.value, status: status(actual, t.value!), note: null } : { measure: m, actual, target: null, status: "no-target", note: null };
  };
  return [followers, weekly("posts_per_week", input.postsInWeek.all), weekly("reels_per_week", input.postsInWeek.reels)];
}
