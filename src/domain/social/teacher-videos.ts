/**
 * Teacher videos: Instagram videos Matt found insightful, sent to the Slack
 * bot as links. No account is followed for advice any more; each video is
 * chosen, and its lessons are what the playbook teaches.
 *
 * For a link: resolve and download it through the reel downloader (RapidAPI,
 * recorded in `social_downloads` as account `teacher`), transcribe it,
 * read its frames (`social_post_visuals`), then list what it teaches
 * (`readLessons`). Only what was read is kept; the file is deleted.
 *
 * A video is saved once, by shortcode, however its link was shared. Sending a
 * saved one again costs nothing; sending one that failed tries it again.
 *
 * The downloader gives the caption and the video, not the creator or when it
 * was posted (checked 2026-11-16), and Meta's oEmbed needs an app review this
 * app does not have. So the creator is whatever the link or the message names
 * (`@handle`), else unknown.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialDownloads, socialLessons, socialPostVisuals, teacherVideos } from "@/db/schema";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { AssemblyAiClient } from "@/integrations/assemblyai";
import type { ReelDownloaderClient } from "@/integrations/reel-downloader";
import type { VideoToolkit } from "@/integrations/video-frames";
import type { DownloadLimits } from "./download-plan";
import { getDownloadUsage } from "./download-queries";
import { readLessons } from "./lesson-sync";
import type { Lesson } from "./lessons";
import { fetchReelVideo } from "./reel-backfill";
import { DOWNLOAD_AUDIO_NOTE, transcribeVideoFile } from "./upload";
import { analyseOne, lookAtVideoFile, type Looked } from "./visual-sync";

export const MAX_LINKS_PER_MESSAGE = 5;

const NOT_USERNAMES = new Set(["reel", "reels", "p", "tv", "explore", "stories", "accounts"]);
const LINK = /https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:([A-Za-z0-9._]{1,30})\/)?(reels?|p|tv)\/([A-Za-z0-9_-]{5,})/g;

export interface InstagramLink {
  shortcode: string;
  /** https://www.instagram.com/reel/<shortcode>/ — the link without tracking. */
  url: string;
  /** The creator, when the link's path names it (instagram.com/<user>/reel/…). */
  username: string | null;
}

export const teacherVideoId = (shortcode: string) => `ig:${shortcode}`;

/** Instagram post and reel links in a message, once each, in order. */
export function parseInstagramLinks(text: string): InstagramLink[] {
  const seen = new Map<string, InstagramLink>();
  for (const m of text.matchAll(LINK)) {
    const [, user, kind, shortcode] = m;
    if (seen.has(shortcode)) continue;
    const path = kind === "p" || kind === "tv" ? kind : "reel";
    const username = user && !NOT_USERNAMES.has(user.toLowerCase()) ? user.toLowerCase() : null;
    seen.set(shortcode, { shortcode, url: `https://www.instagram.com/${path}/${shortcode}/`, username });
  }
  return [...seen.values()];
}

export interface LearnRequest {
  links: InstagramLink[];
  /** An @handle written in the message: who made the video(s). */
  username: string | null;
  /** The rest of the message: why they were saved. */
  note: string | null;
}

/**
 * A Slack message carrying links: the links, an `@handle` if one was written,
 * and whatever else was said as the note. Slack wraps links as `<url|label>`.
 */
export function parseLearnMessage(text: string): LearnRequest {
  const links = parseInstagramLinks(text);
  const rest = text
    .replace(/<[^>]*instagram\.com[^>]*>/gi, " ")
    .replace(/https?:\/\/\S*instagram\.com\S*/gi, " ");
  const handle = rest.match(/(?:^|\s)@([A-Za-z0-9._]{1,30})\b/);
  const note = (handle ? rest.replace(handle[0], " ") : rest).replace(/\s+/g, " ").trim();
  return { links, username: handle ? handle[1].replace(/\.$/, "").toLowerCase() : null, note: note === "" ? null : note };
}

export interface TeacherVideoDeps {
  db: Db;
  anthropic: AnthropicClient;
  video: VideoToolkit;
  downloader: ReelDownloaderClient;
  transcriber?: AssemblyAiClient;
  /** Only the plan's monthly limit applies: each video is asked for by a person. */
  limits: Pick<DownloadLimits, "plan">;
  now: () => Date;
}

export interface SavedVideo {
  id: string;
  url: string;
  username: string | null;
  caption: string | null;
  note: string | null;
}

export type LearnResult =
  | { status: "already-saved"; video: SavedVideo; lessons: Lesson[] }
  | {
      status: "saved";
      video: SavedVideo;
      lessons: Lesson[];
      /** ok: lessons found; none: it teaches nothing; error: retried by the daily sync. */
      lessonsRead: "ok" | "none" | "error";
      /** What its frames showed, or null when they could not be read. */
      summary: string | null;
      transcribed: boolean;
      /** Things that went wrong without stopping it: no transcript, frames unread. */
      problems: string[];
    }
  | { status: "failed"; video: SavedVideo; reason: string; detail: string }
  | { status: "refused"; reason: "plan-limit" | "quota-exhausted"; detail: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function lessonsOf(db: Db, id: string): Promise<Lesson[]> {
  const rows = await db
    .select({ principle: socialLessons.principle, howToApply: socialLessons.howToApply, area: socialLessons.area, kind: socialLessons.kind, quote: socialLessons.quote })
    .from(socialLessons)
    .where(eq(socialLessons.postId, id));
  return rows.map((r) => ({ ...r, area: r.area as Lesson["area"], kind: r.kind as Lesson["kind"] }));
}

export async function learnFromVideo(
  deps: TeacherVideoDeps,
  request: { link: InstagramLink; username: string | null; note: string | null; savedBy: string | null },
): Promise<LearnResult> {
  const now = deps.now();
  const id = teacherVideoId(request.link.shortcode);
  const username = request.username ?? request.link.username;
  const [prior] = await deps.db.select().from(teacherVideos).where(eq(teacherVideos.id, id)).limit(1);

  if (prior?.status === "ok") {
    // Sent again: nothing is downloaded, but a handle or note it lacked is kept.
    const fill = { ...(prior.username === null && username ? { username } : {}), ...(prior.note === null && request.note ? { note: request.note } : {}) };
    if (Object.keys(fill).length > 0) await deps.db.update(teacherVideos).set(fill).where(eq(teacherVideos.id, id));
    return {
      status: "already-saved",
      video: { id, url: prior.url, username: prior.username ?? fill.username ?? null, caption: prior.caption, note: prior.note ?? fill.note ?? null },
      lessons: await lessonsOf(deps.db, id),
    };
  }

  const { usage, quota } = await getDownloadUsage(deps.db, now);
  const used = usage.own + usage.teacher + usage.peer;
  if (quota.remaining !== null && quota.remaining <= 0 && (quota.resetAt === null || quota.resetAt > now)) {
    return { status: "refused", reason: "quota-exhausted", detail: `The downloader's quota is used up${quota.resetAt ? ` until ${quota.resetAt.toISOString().slice(0, 10)}` : ""}.` };
  }
  if (used >= deps.limits.plan) {
    return { status: "refused", reason: "plan-limit", detail: `${used} downloads this month already, the plan's limit of ${deps.limits.plan} (RAPIDAPI_MONTHLY_LIMIT).` };
  }

  const base = {
    shortcode: request.link.shortcode,
    url: request.link.url,
    username: username ?? prior?.username ?? null,
    note: request.note ?? prior?.note ?? null,
    savedBy: prior?.savedBy ?? request.savedBy,
    savedAt: prior?.savedAt ?? now,
    attempts: (prior?.attempts ?? 0) + 1,
  };
  const save = async (values: Partial<typeof teacherVideos.$inferInsert> & { status: string }) => {
    const row = { ...base, ...values };
    await deps.db.insert(teacherVideos).values({ id, ...row }).onConflictDoUpdate({ target: teacherVideos.id, set: row });
  };
  const video = (caption: string | null): SavedVideo => ({ id, url: base.url, username: base.username, caption, note: base.note });

  const calledAt = deps.now();
  const fetched = await fetchReelVideo(deps, request.link.url);
  await deps.db.insert(socialDownloads).values({
    postId: id, account: "teacher", username: base.username, calledAt,
    outcome: fetched.ok ? "ok" : fetched.reason, detail: fetched.ok ? null : fetched.detail, quality: fetched.ok ? fetched.quality : null,
    rateLimit: fetched.rate.limit, rateRemaining: fetched.rate.remaining,
    rateResetAt: fetched.rate.resetSeconds === null ? null : new Date(calledAt.getTime() + fetched.rate.resetSeconds * 1000),
  });
  if (!fetched.ok) {
    await save({ status: "failed", detail: `${fetched.reason}: ${fetched.detail}`.slice(0, 500) });
    return { status: "failed", video: video(prior?.caption ?? null), reason: fetched.reason, detail: fetched.detail };
  }

  try {
    let looked: Looked;
    try {
      looked = await lookAtVideoFile(deps, fetched.path, null);
    } catch (err) {
      const detail = `ffmpeg could not read the video: ${errorText(err).slice(0, 300)}`;
      await save({ status: "failed", caption: fetched.caption, detail });
      return { status: "failed", video: video(fetched.caption), reason: "unreadable-video", detail };
    }
    const facts = looked.facts!;
    const problems: string[] = [];
    const words = await transcribeVideoFile(deps, fetched.path, facts);
    if (!deps.transcriber) problems.push("not transcribed: ASSEMBLYAI_API_KEY is not set");
    else if (words.error) problems.push(`not transcribed: ${words.error}`);

    await save({
      status: "ok",
      caption: fetched.caption,
      transcript: words.transcript,
      openingWords: words.openingWords,
      durationMs: facts.durationMs,
      readAt: deps.now(),
      detail: problems.length > 0 ? problems.join("; ").slice(0, 500) : null,
    });

    const [visual] = await deps.db.select({ attempts: socialPostVisuals.attempts }).from(socialPostVisuals).where(eq(socialPostVisuals.postId, id)).limit(1);
    const errors: string[] = [];
    const seen = await analyseOne(deps, "peer", { id, caption: fetched.caption, openingWords: words.openingWords, visualAttempts: visual?.attempts ?? 0 }, async () => looked, errors, {
      source: "api_backfill",
      songUsed: null,
      audioNote: DOWNLOAD_AUDIO_NOTE,
      audio: words.transcript ? "speech" : looked.audio,
    });
    if (seen.outcome !== "ok") problems.push(`frames not read: ${seen.detail ?? seen.outcome}`);

    const read = await readLessons(deps, id);
    if (read.status === "error") problems.push(`lessons not read yet (the daily sync tries again): ${read.detail}`);
    return {
      status: "saved",
      video: video(fetched.caption),
      lessons: read.lessons,
      lessonsRead: read.status,
      summary: seen.outcome === "ok" ? seen.summary ?? null : null,
      transcribed: words.transcribed,
      problems,
    };
  } finally {
    await fetched.remove();
  }
}

const lessonLine = (l: Lesson) => `  • ${l.principle}${l.kind === "claim" ? " _(their claim — not verified)_" : ""}`;

/** The Slack reply for one link: what was saved and what it teaches, in plain words. */
export function describeLearnResult(link: InstagramLink, result: LearnResult): string {
  const by = (v: { username: string | null }) => (v.username ? ` by @${v.username}` : "");
  switch (result.status) {
    case "refused":
      return `Couldn't download ${link.url} — ${result.detail} Nothing was saved.`;
    case "failed":
      return `Couldn't save ${link.url}${by(result.video)}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}. ` +
        "Check the link opens and isn't from a private account; sending it again tries again.";
    case "already-saved":
      return [
        `Already saved${by(result.video)}: ${link.url} — nothing downloaded again.`,
        ...(result.lessons.length > 0 ? ["What it teaches:", ...result.lessons.map(lessonLine)] : ["It taught nothing specific when it was read."]),
      ].join("\n");
    case "saved": {
      const lines = [`*Saved*${by(result.video)}: ${link.url}`];
      if (result.summary) lines.push(`What it shows: ${result.summary}`);
      lines.push(result.transcribed ? "Transcribed." : "No speech transcribed.");
      if (result.lessonsRead === "ok") lines.push("What it teaches:", ...result.lessons.map(lessonLine));
      else if (result.lessonsRead === "none") lines.push("It doesn't seem to teach anything specific — saved anyway.");
      if (!result.video.username) lines.push("_I can't tell who made it from the link. Send it again with @theirhandle to note it._");
      for (const p of result.problems) lines.push(`_${p}_`);
      return lines.join("\n");
    }
  }
}
