/**
 * Reads teacher accounts' posts for lessons (`lessons.ts`), newest first,
 * LESSONS_PER_RUN at a time, after the visual step has read their slides.
 * A post read again — an upload brought its words — has its lessons replaced.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialLessonRuns, socialLessons, socialPeerPosts, socialPeers, socialPostVisuals } from "@/db/schema";
import type { AnthropicClient } from "@/integrations/anthropic";
import { buildLessonPrompt, lessonsReady, parseLessons, shouldExtractLessons, MAX_LESSON_ATTEMPTS } from "./lessons";

export const LESSONS_PER_RUN = 20;

export interface LessonSyncResult {
  /** Posts read that taught something. */
  extracted: number;
  /** Posts read that taught nothing. */
  none: number;
  failed: number;
  /** Lessons stored this run. */
  lessons: number;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const formatOf = (p: { mediaType: string; mediaProductType: string | null }) =>
  p.mediaProductType === "REELS" ? "Reel" : p.mediaType === "CAROUSEL_ALBUM" ? "Carousel" : p.mediaType === "VIDEO" ? "Video" : "Image";

export async function extractLessons(
  deps: { db: Db; anthropic: AnthropicClient; now: () => Date },
  opts: { waitForVisuals: boolean },
  errors: string[],
): Promise<LessonSyncResult> {
  const now = deps.now();
  const out: LessonSyncResult = { extracted: 0, none: 0, failed: 0, lessons: 0 };
  const candidates = await deps.db
    .select({
      id: socialPeerPosts.id,
      username: socialPeerPosts.username,
      caption: socialPeerPosts.caption,
      mediaType: socialPeerPosts.mediaType,
      mediaProductType: socialPeerPosts.mediaProductType,
      transcript: socialPeerPosts.transcript,
      onScreenText: socialPostVisuals.onScreenText,
      visualStatus: socialPostVisuals.status,
      visualAttempts: socialPostVisuals.attempts,
      runStatus: socialLessonRuns.status,
      runAttempts: socialLessonRuns.attempts,
    })
    .from(socialPeerPosts)
    .innerJoin(socialPeers, and(eq(socialPeers.username, socialPeerPosts.username), eq(socialPeers.purpose, "teacher")))
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPeerPosts.id))
    .leftJoin(socialLessonRuns, eq(socialLessonRuns.postId, socialPeerPosts.id))
    .where(sql`(${socialLessonRuns.status} IS NULL OR ${socialLessonRuns.status} = 'stale' OR (${socialLessonRuns.status} = 'error' AND ${socialLessonRuns.attempts} < ${MAX_LESSON_ATTEMPTS}))`)
    .orderBy(desc(socialPeerPosts.postedAt))
    .limit(LESSONS_PER_RUN * 3);

  let tried = 0;
  for (const post of candidates) {
    if (tried >= LESSONS_PER_RUN) break;
    const prior = post.runStatus === null ? null : { status: post.runStatus, attempts: post.runAttempts ?? 0 };
    if (!shouldExtractLessons(prior)) continue;
    if (!lessonsReady(post, opts.waitForVisuals)) continue;
    tried++;
    // A stale run was reset by an upload; its attempts start again.
    const attempts = (prior?.status === "stale" ? 0 : prior?.attempts ?? 0) + 1;
    const record = async (row: Omit<typeof socialLessonRuns.$inferInsert, "postId" | "attempts" | "analysedAt">) => {
      const values = { postId: post.id, attempts, analysedAt: now, ...row };
      const { postId: _postId, ...set } = values;
      await deps.db.insert(socialLessonRuns).values(values).onConflictDoUpdate({ target: socialLessonRuns.postId, set });
    };

    const built = buildLessonPrompt({ username: post.username, format: formatOf(post), caption: post.caption, slideText: post.onScreenText, transcript: post.transcript });
    if (built === null) {
      await record({ status: "none", basis: null, lessonCount: 0, detail: "nothing to read" });
      out.none++;
      continue;
    }

    let lessons = null;
    let detail: string | null = null;
    try {
      const result = await deps.anthropic.generate(built.prompt, { maxTokens: 1500, temperature: 0 });
      lessons = parseLessons(result.text);
      if (lessons === null) detail = `unreadable answer: ${result.text.slice(0, 200)}`;
    } catch (err) {
      detail = errorText(err).slice(0, 300);
    }
    if (lessons === null) {
      await record({ status: "error", basis: built.basis, lessonCount: null, detail });
      out.failed++;
      if (attempts >= MAX_LESSON_ATTEMPTS) errors.push(`Lessons for post ${post.id} (@${post.username}) could not be read after ${attempts} attempts: ${detail}`);
      continue;
    }

    if (prior !== null) await deps.db.delete(socialLessons).where(eq(socialLessons.postId, post.id));
    if (lessons.length > 0) {
      await deps.db.insert(socialLessons).values(lessons.map((l) => ({ postId: post.id, username: post.username, ...l })));
      out.extracted++;
      out.lessons += lessons.length;
    } else {
      out.none++;
    }
    await record({ status: lessons.length > 0 ? "ok" : "none", basis: built.basis, lessonCount: lessons.length, detail: null });
  }
  return out;
}
