/**
 * Lessons from teacher accounts — Instagram accounts followed for their
 * advice rather than as peers to benchmark (`social_peers.purpose =
 * 'teacher'`).
 *
 * Claude reads what Instagram gives of each post — the caption, the text on
 * its slides or image (from the visual reading), and the transcript of a reel
 * Matt uploaded — and records what it teaches: a principle in our own words,
 * how to apply it, the part of a post it is about, and whether it is a
 * practice or a claim (an assertion about the algorithm or a number that
 * nothing here has verified). A post that teaches nothing is `none`, an
 * answer; an unreadable reply is an error, retried three times.
 *
 * Pure — no database, no clock.
 */

export const LESSON_AREAS = [
  "hook", "caption", "reel-structure", "carousel", "visuals", "audio",
  "posting-rhythm", "engagement", "growth", "content-ideas", "other",
] as const;
export type LessonArea = (typeof LESSON_AREAS)[number];

export interface Lesson {
  principle: string;
  howToApply: string | null;
  area: LessonArea;
  /** practice: a way of doing something. claim: an assertion of fact nothing here verified. */
  kind: "practice" | "claim";
  quote: string | null;
}

export const MAX_LESSONS_PER_POST = 5;
export const MAX_LESSON_ATTEMPTS = 3;
const MAX_QUOTE = 200;

export function buildLessonPrompt(input: {
  username: string;
  format: string;
  caption: string | null;
  slideText: Array<{ at: string; text: string }> | null;
  transcript: string | null;
}): { prompt: string; basis: string } | null {
  const caption = input.caption?.trim() ?? "";
  const slides = (input.slideText ?? []).filter((s) => s.text.trim() !== "");
  const transcript = input.transcript?.trim() ?? "";
  if (caption === "" && slides.length === 0 && transcript === "") return null;

  const basis = [caption !== "" && "caption", slides.length > 0 && "slides", transcript !== "" && "transcript"].filter(Boolean).join("+");
  const parts = [
    `@${input.username} is an Instagram account Rad & Happy follows to learn from: its posts teach how to make Instagram content that grows an account. ` +
      "Rad & Happy is a small stationery brand; its founder Tara posts reels and carousels of her hand-drawn doodle and coloring illustrations.",
    "List what this post teaches. For each lesson return: `principle` (one sentence, in your own words — never copy their phrasing as ours); " +
      "`howToApply` (one sentence on how Tara could apply it to her own posts, or null); " +
      `\`area\` (one of ${LESSON_AREAS.join(", ")}); ` +
      '`kind` ("practice" for a way of doing something, "claim" for an assertion of fact — about the algorithm, reach, or a number — that the post does not prove); ' +
      "`quote` (their words for it, under 25 words, or null).",
    `At most ${MAX_LESSONS_PER_POST} lessons. A post that teaches nothing (a promotion, a personal update, a joke) gets an empty list. ` +
      'Return JSON only: {"lessons": [...]}.',
    `Format: ${input.format}`,
    `Caption:\n"""\n${caption.slice(0, 3000) || "(none)"}\n"""`,
  ];
  if (slides.length > 0) parts.push(`Text on the post:\n${slides.map((s) => `${s.at}: ${s.text}`).join("\n").slice(0, 4000)}`);
  if (transcript !== "") parts.push(`What is said in the reel:\n"""\n${transcript.slice(0, 8000)}\n"""`);
  return { prompt: parts.join("\n\n"), basis };
}

/** Null for anything that is not `{ lessons: [...] }` — an unreadable reply is a failure, never "no lessons". */
export function parseLessons(raw: string): Lesson[] | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null || !Array.isArray((obj as { lessons?: unknown }).lessons)) return null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return ((obj as { lessons: unknown[] }).lessons)
    .filter((l): l is Record<string, unknown> => typeof l === "object" && l !== null)
    .map((l) => {
      const area = text(l.area)?.toLowerCase() ?? "";
      return {
        principle: text(l.principle) ?? "",
        howToApply: text(l.howToApply),
        area: ((LESSON_AREAS as readonly string[]).includes(area) ? area : "other") as LessonArea,
        kind: (l.kind === "practice" ? "practice" : "claim") as Lesson["kind"],
        quote: text(l.quote)?.slice(0, MAX_QUOTE) ?? null,
      };
    })
    .filter((l) => l.principle !== "")
    .slice(0, MAX_LESSONS_PER_POST);
}

/** `ok` and `none` are answers; `stale` (an upload brought words) and errors are read again. */
export function shouldExtractLessons(state: { status: string; attempts: number } | null): boolean {
  if (state === null) return true;
  if (state.status === "ok" || state.status === "none") return false;
  if (state.status === "stale") return true;
  return state.attempts < MAX_LESSON_ATTEMPTS;
}

/**
 * A post's text on screen comes from its visual reading, so wait until that
 * has finished — read, nothing to read, or given up on. Without the visual
 * step there is nothing to wait for.
 */
export function lessonsReady(post: { visualStatus: string | null; visualAttempts: number | null }, waitForVisuals: boolean): boolean {
  if (!waitForVisuals) return true;
  if (post.visualStatus === "ok" || post.visualStatus === "unavailable") return true;
  return post.visualStatus === "error" && (post.visualAttempts ?? 0) >= 3;
}

export interface LessonRow extends Lesson {
  postId: string;
  username: string;
  permalink: string | null;
  postedAt: Date;
  /** What the lesson was read from: caption, slides, transcript, joined with +. */
  basis: string | null;
}

const key = (principle: string) => principle.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/**
 * Lessons by area, the most-taught areas first; the same principle taught in
 * several posts is one lesson with every post as a source. Only identical
 * wording merges — similar lessons are left for the reader to weigh.
 */
export function groupLessons(rows: LessonRow[]) {
  const areas = new Map<LessonArea, Map<string, { principle: string; howToApply: string | null; kind: Lesson["kind"]; quote: string | null; sources: Array<{ postId: string; username: string; permalink: string | null; postedAt: string; basis: string | null }> }>>();
  for (const r of rows) {
    const area = areas.get(r.area) ?? new Map();
    const k = key(r.principle);
    const lesson = area.get(k) ?? { principle: r.principle, howToApply: r.howToApply, kind: r.kind, quote: r.quote, sources: [] };
    lesson.sources.push({ postId: r.postId, username: r.username, permalink: r.permalink, postedAt: r.postedAt.toISOString(), basis: r.basis });
    area.set(k, lesson);
    areas.set(r.area, area);
  }
  return [...areas]
    .map(([area, lessons]) => ({ area, lessons: [...lessons.values()].sort((a, b) => b.sources.length - a.sources.length) }))
    .sort((a, b) => b.lessons.length - a.lessons.length);
}
