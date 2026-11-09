/**
 * What a post WAS — its hook, the kind of hook, topic, approach and audience —
 * so the weekly review can say which kinds of post do well, not only which
 * posts did.
 *
 * Read by Claude from the caption and, for a video, the transcript. It reads
 * words only: a hook that is on-screen text, a visual, or a trending sound is
 * invisible to it, and the stored `basis` says what it had to go on.
 *
 * Pure — no database, no model, no clock.
 */

/** The kinds of opening counted in the review's patterns. */
export const HOOK_TYPES = [
  "question",
  "bold-claim",
  "relatable-problem",
  "how-to-promise",
  "list",
  "story",
  "reveal-or-result",
  "trend-or-meme",
  "product-showcase",
  "announcement",
  "none",
  "other",
] as const;
export type HookType = (typeof HOOK_TYPES)[number];

/** What the post sets out to do — knowable from words, unlike how it was filmed. */
export const APPROACHES = [
  "teach",
  "entertain",
  "relate",
  "inspire",
  "show-process",
  "sell",
  "announce",
  "community",
  "other",
] as const;
export type Approach = (typeof APPROACHES)[number];

export const MAX_ANALYSIS_ATTEMPTS = 3;

export type AnalysisBasis = "transcript" | "caption";

export interface PostAnalysis {
  summary: string;
  hook: string | null;
  /** Null when there is no hook. */
  hookSource: "speech" | "caption" | null;
  hookType: HookType;
  topic: string | null;
  approach: Approach;
  audience: string | null;
  product: string | null;
  callToAction: string | null;
}

const INSTRUCTION =
  "You are cataloguing an Instagram post by Rad & Happy, a small stationery brand (planners, " +
  "coloring and doodle books, homeschool materials, calendars) run by its founder Tara, so the " +
  "brand can learn which kinds of post grow its audience. Return JSON only, with these fields: " +
  "`summary`, one sentence on what the post is; " +
  "`hook`, the opening line meant to stop the scroll, quoted exactly (for a video, the first thing " +
  "said; otherwise the caption's first line), or null if there is none; " +
  `\`hookType\`, one of ${HOOK_TYPES.join(", ")}; ` +
  "`topic`, 2-4 lowercase words; " +
  `\`approach\`, what the post sets out to do, one of ${APPROACHES.join(", ")}; ` +
  "`audience`, who it speaks to in 2-4 lowercase words (for example: homeschool parents, " +
  "teachers, adults who color, planner lovers); " +
  "`product`, the product named, or null; " +
  "`callToAction`, what the viewer is asked to do, quoted or closely paraphrased, or null. " +
  "Use only what the words support and null for anything they do not.";

/**
 * The prompt for one post, and what it was built from. Null when there is
 * nothing to read: asked about an empty post, a model describes one anyway.
 */
export function buildPostAnalysisPrompt(input: {
  format: string;
  caption: string | null;
  transcript: string | null;
}): { prompt: string; basis: AnalysisBasis } | null {
  const caption = input.caption?.trim() ?? "";
  const transcript = input.transcript?.trim() ?? "";
  if (caption === "" && transcript === "") return null;

  const parts = [INSTRUCTION, "", `Format: ${input.format}`, `Caption:\n"""\n${caption.slice(0, 3000) || "(none)"}\n"""`];
  if (transcript !== "") {
    parts.push(
      `Transcript:\n"""\n${transcript.slice(0, 8000)}\n"""`,
      "You cannot see the video: on-screen text, visuals and music are invisible to you, so do not guess at them.",
    );
  } else {
    parts.push("There is no transcript: you have the caption only and cannot see the image or video.");
  }
  return { prompt: parts.join("\n"), basis: transcript !== "" ? "transcript" : "caption" };
}

/**
 * Parses the model's answer. Null for anything that is not a JSON object with
 * something in it — an unreadable answer is a failure to retry, never an
 * analysis that found nothing.
 */
export function parsePostAnalysis(raw: string, basis: AnalysisBasis): PostAnalysis | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const text = (key: string) => {
    const v = obj[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const oneOf = <T extends string>(key: string, values: readonly T[]): T | null => {
    const v = text(key)?.toLowerCase();
    if (v === undefined || v === null) return null;
    return (values as readonly string[]).includes(v) ? (v as T) : ("other" as T);
  };

  const hook = text("hook");
  const analysis: PostAnalysis = {
    summary: text("summary") ?? "",
    hook,
    hookSource: hook === null ? null : basis === "transcript" ? "speech" : "caption",
    hookType: oneOf("hookType", HOOK_TYPES) ?? (hook === null ? "none" : "other"),
    topic: text("topic")?.toLowerCase() ?? null,
    approach: oneOf("approach", APPROACHES) ?? "other",
    audience: text("audience")?.toLowerCase() ?? null,
    product: text("product"),
    callToAction: text("callToAction"),
  };
  const empty = analysis.summary === "" && hook === null && analysis.topic === null && analysis.audience === null &&
    analysis.product === null && analysis.callToAction === null && text("hookType") === null && text("approach") === null;
  return empty ? null : analysis;
}

/**
 * Whether a post is ready to analyse. A video waits until its transcription
 * is settled — transcribed, found silent, or given up on — because analysed
 * from the caption while the transcript is still coming, it would be filed
 * as caption-only for good.
 */
export function readyForAnalysis(post: {
  mediaType: string;
  mediaProductType: string | null;
  transcriptionStatus: string | null;
  transcriptionAttempts: number;
}, maxTranscriptionAttempts: number): boolean {
  const isVideo = post.mediaType === "VIDEO" || post.mediaProductType === "REELS";
  if (!isVideo) return true;
  if (post.transcriptionStatus === "ok" || post.transcriptionStatus === "no-audio") return true;
  return post.transcriptionStatus !== null && post.transcriptionAttempts >= maxTranscriptionAttempts;
}

/** Whether to analyse a post, from what is recorded of earlier attempts. */
export function shouldAnalysePost(state: { status: string; attempts: number } | null): boolean {
  if (state === null) return true;
  if (state.status === "ok") return false;
  return state.attempts < MAX_ANALYSIS_ATTEMPTS;
}
