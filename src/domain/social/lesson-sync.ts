/**
 * Reads saved teacher videos (`teacher_videos`) for lessons (`lessons.ts`).
 *
 * A video sent to the Slack bot is read at once (`readLessons`, from
 * `teacher-videos.ts`); the daily social sync retries any that failed or were
 * left stale, LESSONS_PER_RUN at a time, newest first. A video read again has
 * its lessons replaced.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialLessonRuns, socialLessons, socialPostVisuals, teacherVideos } from "@/db/schema";
import type { AnthropicClient } from "@/integrations/anthropic";
import { buildLessonPrompt, parseLessons, shouldExtractLessons, MAX_LESSON_ATTEMPTS, type Lesson } from "./lessons";

export const LESSONS_PER_RUN = 20;

export interface LessonSyncResult {
  /** Videos read that taught something. */
  extracted: number;
  /** Videos read that taught nothing. */
  none: number;
  failed: number;
  /** Lessons stored this run. */
  lessons: number;
}

export type LessonRead =
  | { status: "ok" | "none"; lessons: Lesson[] }
  | { status: "error"; lessons: []; detail: string; attempts: number };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One saved video's lessons, read from its caption, the text on screen and
 * its transcript, and stored in place of any it had.
 */
export async function readLessons(deps: { db: Db; anthropic: AnthropicClient; now: () => Date }, videoId: string): Promise<LessonRead> {
  const [video] = await deps.db
    .select({
      id: teacherVideos.id,
      username: teacherVideos.username,
      caption: teacherVideos.caption,
      note: teacherVideos.note,
      transcript: teacherVideos.transcript,
      onScreenText: socialPostVisuals.onScreenText,
      runStatus: socialLessonRuns.status,
      runAttempts: socialLessonRuns.attempts,
    })
    .from(teacherVideos)
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, teacherVideos.id))
    .leftJoin(socialLessonRuns, eq(socialLessonRuns.postId, teacherVideos.id))
    .where(eq(teacherVideos.id, videoId))
    .limit(1);
  if (!video) throw new Error(`No saved teacher video ${videoId}`);

  // An earlier error counts towards three; anything else starts again.
  const attempts = (video.runStatus === "error" ? video.runAttempts ?? 0 : 0) + 1;
  const record = async (row: Omit<typeof socialLessonRuns.$inferInsert, "postId" | "attempts" | "analysedAt">) => {
    const values = { postId: video.id, attempts, analysedAt: deps.now(), ...row };
    const { postId: _postId, ...set } = values;
    await deps.db.insert(socialLessonRuns).values(values).onConflictDoUpdate({ target: socialLessonRuns.postId, set });
  };

  const built = buildLessonPrompt({ username: video.username, note: video.note, format: "Reel", caption: video.caption, slideText: video.onScreenText, transcript: video.transcript });
  if (built === null) {
    await deps.db.delete(socialLessons).where(eq(socialLessons.postId, video.id));
    await record({ status: "none", basis: null, lessonCount: 0, detail: "nothing to read: no caption, text on screen or speech" });
    return { status: "none", lessons: [] };
  }

  let lessons: Lesson[] | null = null;
  let detail = "";
  try {
    const result = await deps.anthropic.generate(built.prompt, { maxTokens: 1500, temperature: 0 });
    lessons = parseLessons(result.text);
    if (lessons === null) detail = `unreadable answer: ${result.text.slice(0, 200)}`;
  } catch (err) {
    detail = errorText(err).slice(0, 300);
  }
  if (lessons === null) {
    await record({ status: "error", basis: built.basis, lessonCount: null, detail });
    return { status: "error", lessons: [], detail, attempts };
  }

  await deps.db.delete(socialLessons).where(eq(socialLessons.postId, video.id));
  if (lessons.length > 0) {
    await deps.db.insert(socialLessons).values(lessons.map((l) => ({ postId: video.id, username: video.username ?? "unknown", ...l })));
  }
  await record({ status: lessons.length > 0 ? "ok" : "none", basis: built.basis, lessonCount: lessons.length, detail: null });
  return { status: lessons.length > 0 ? "ok" : "none", lessons };
}

/**
 * Saved videos still owed a reading — failed or stale — read now, newest
 * first. Their frames were read when they were sent and are never read
 * again, so nothing here waits for them: a video whose frames failed is
 * read from its caption and transcript.
 */
export async function extractLessons(
  deps: { db: Db; anthropic: AnthropicClient; now: () => Date },
  errors: string[],
): Promise<LessonSyncResult> {
  const out: LessonSyncResult = { extracted: 0, none: 0, failed: 0, lessons: 0 };
  const candidates = await deps.db
    .select({
      id: teacherVideos.id,
      username: teacherVideos.username,
      runStatus: socialLessonRuns.status,
      runAttempts: socialLessonRuns.attempts,
    })
    .from(teacherVideos)
    .leftJoin(socialLessonRuns, eq(socialLessonRuns.postId, teacherVideos.id))
    .where(and(
      eq(teacherVideos.status, "ok"),
      sql`(${socialLessonRuns.status} IS NULL OR ${socialLessonRuns.status} = 'stale' OR (${socialLessonRuns.status} = 'error' AND ${socialLessonRuns.attempts} < ${MAX_LESSON_ATTEMPTS}))`,
    ))
    .orderBy(desc(teacherVideos.savedAt))
    .limit(LESSONS_PER_RUN * 3);

  let tried = 0;
  for (const video of candidates) {
    if (tried >= LESSONS_PER_RUN) break;
    const prior = video.runStatus === null ? null : { status: video.runStatus, attempts: video.runAttempts ?? 0 };
    if (!shouldExtractLessons(prior)) continue;
    tried++;
    let read: LessonRead;
    try {
      read = await readLessons(deps, video.id);
    } catch (err) {
      errors.push(`Lessons for saved video ${video.id}: ${errorText(err)}`);
      out.failed++;
      continue;
    }
    if (read.status === "error") {
      out.failed++;
      if (read.attempts >= MAX_LESSON_ATTEMPTS) errors.push(`Lessons for saved video ${video.id}${video.username ? ` (@${video.username})` : ""} could not be read after ${read.attempts} attempts: ${read.detail}`);
    } else if (read.status === "ok") {
      out.extracted++;
      out.lessons += read.lessons.length;
    } else {
      out.none++;
    }
  }
  return out;
}
