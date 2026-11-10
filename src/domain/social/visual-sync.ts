/**
 * The visual half of the Instagram sync: for each post not yet looked at —
 * Tara's from the last 90 days, the peers' from the last 30 — fetch what
 * Instagram will give, measure a reel's video with ffmpeg, and ask Claude
 * what it shows (`visual-analysis.ts`).
 *
 * What there is to look at decides what can be known:
 * - Tara's reel with its video: frames at 0, 1, 2, 3s then every 3s, cuts,
 *   length, loudness, and a contact sheet kept for the dashboard;
 * - Tara's reel without it (Instagram withholds licensed-music reels): the
 *   cover, and "licensed music, likely" for its sound;
 * - a carousel: every slide; an image: itself;
 * - a peer's post: the image, slides or reel cover Business Discovery gave —
 *   never a peer's video, so never its sound.
 * A post with nothing at all is `unavailable` and not asked about again.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialPeerPosts, socialPosts, socialPostVisuals } from "@/db/schema";
import type { AnthropicClient, PromptImage } from "@/integrations/anthropic";
import type { InstagramApiClient } from "@/integrations/instagram-api";
import type { FetchedMedia } from "@/integrations/media-download";
import { frameTimes, type VideoFacts, type VideoToolkit } from "@/integrations/video-frames";
import {
  buildVisualPrompt,
  classifyAudio,
  parseVisualAnalysis,
  shouldAnalyseVisual,
  MAX_VISUAL_ATTEMPTS,
  type AudioKind,
  type VisualKind,
} from "./visual-analysis";

export const OWN_VISUAL_DAYS = 90;
export const PEER_VISUAL_DAYS = 30;
/** Per run. Enough to clear 90 days of Tara's posts within a few days. */
export const OWN_VISUALS_PER_RUN = 40;
export const PEER_VISUALS_PER_RUN = 20;
/** A carousel holds up to 20; ten slides say what it is. */
const MAX_SLIDES = 10;

export interface VisualSyncDeps {
  db: Db;
  client: InstagramApiClient;
  anthropic: AnthropicClient;
  video: VideoToolkit;
  fetchMedia: (url: string) => Promise<FetchedMedia>;
  writeTemp: (data: Buffer, extension: string) => Promise<{ path: string; remove: () => Promise<void> }>;
  now: () => Date;
}

export interface VisualSyncResult {
  analysed: number;
  failed: number;
  unavailable: number;
  /** Each failure this run and why — retried later, but named now. */
  failures: Array<{ postId: string; detail: string }>;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const flag = (v: boolean | null) => (v === null ? null : v ? 1 : 0);

async function picture(deps: VisualSyncDeps, url: string, label: string): Promise<PromptImage> {
  const { data, contentType } = await deps.fetchMedia(url);
  if (!(IMAGE_TYPES as readonly string[]).includes(contentType)) throw new Error(`Unsupported image type "${contentType}"`);
  return { label, mediaType: contentType as ImageType, data };
}

export interface Looked {
  kind: VisualKind;
  images: PromptImage[];
  frameTimesMs: number[] | null;
  facts: VideoFacts | null;
  sheet: Buffer | null;
  audio: AudioKind | null;
}

/** A reel's video file on disk: measured, framed and tiled by ffmpeg. */
export async function lookAtVideoFile(
  deps: Pick<VisualSyncDeps, "video">,
  path: string,
  transcriptionStatus: string | null,
): Promise<Looked> {
  const facts = await deps.video.inspect(path);
  const times = frameTimes(facts.durationMs);
  const frames = await deps.video.frames(path, times);
  const labels = buildVisualPrompt({ kind: "frames", account: "own", caption: null, frameTimesMs: times }).labels;
  return {
    kind: "frames",
    images: frames.map((data, i) => ({ label: labels[i], mediaType: "image/jpeg" as const, data })),
    frameTimesMs: times,
    facts,
    sheet: await deps.video.contactSheet(frames),
    audio: classifyAudio({ videoAvailable: true, facts, transcriptionStatus }),
  };
}

/** What there is to look at for one of Tara's posts. Null: nothing. */
async function lookAtOwn(
  deps: VisualSyncDeps,
  post: { id: string; caption: string | null; mediaType: string; mediaProductType: string | null; transcriptionStatus: string | null },
): Promise<Looked | null> {
  const assets = await deps.client.getMediaAssets(post.id);
  const isVideo = post.mediaType === "VIDEO" || post.mediaProductType === "REELS";
  if (isVideo && assets.videoUrl) {
    const file = await deps.writeTemp((await deps.fetchMedia(assets.videoUrl)).data, "mp4");
    try {
      return await lookAtVideoFile(deps, file.path, post.transcriptionStatus);
    } finally {
      await file.remove();
    }
  }
  if (isVideo && assets.coverUrl) {
    return { kind: "cover", images: [await picture(deps, assets.coverUrl, "Cover image")], frameTimesMs: null, facts: null, sheet: null, audio: classifyAudio({ videoAvailable: false, facts: null, transcriptionStatus: null }) };
  }
  return lookAtImages(deps, assets.imageUrls);
}

async function lookAtImages(deps: VisualSyncDeps, urls: string[]): Promise<Looked | null> {
  if (urls.length === 0) return null;
  const slides = urls.slice(0, MAX_SLIDES);
  const kind: VisualKind = slides.length > 1 ? "slides" : "image";
  const labels = kind === "slides" ? slides.map((_, i) => `Slide ${i + 1}`) : ["Image"];
  const images = await Promise.all(slides.map((u, i) => picture(deps, u, labels[i])));
  return { kind, images, frameTimesMs: null, facts: null, sheet: null, audio: null };
}

/** A peer post: its stored pictures, a reel's being its cover. */
async function lookAtPeer(deps: VisualSyncDeps, post: { mediaType: string; mediaProductType: string | null; imageUrls: string[] | null }): Promise<Looked | null> {
  const urls = post.imageUrls ?? [];
  if (urls.length === 0) return null;
  if (post.mediaType === "VIDEO" || post.mediaProductType === "REELS") {
    return { kind: "cover", images: [await picture(deps, urls[0], "Cover image")], frameTimesMs: null, facts: null, sheet: null, audio: null };
  }
  return lookAtImages(deps, urls);
}

async function record(deps: Pick<VisualSyncDeps, "db">, row: typeof socialPostVisuals.$inferInsert): Promise<void> {
  const { postId: _postId, ...set } = row;
  await deps.db.insert(socialPostVisuals).values(row).onConflictDoUpdate({ target: socialPostVisuals.postId, set });
}

const EMPTY = {
  basis: null, frameTimesMs: null, imageCount: null, summary: null, visualType: null, handDrawn: null, onScreenText: null,
  firstFrame: null, visualHook: null, faceInFirst2s: null, productVisible: null, productFirstSeen: null, setting: null,
  emotion: null, branding: null, audio: null, durationMs: null, cuts: null, cutsPerMinute: null, meanVolumeDb: null, contactSheet: null,
};

/** Fields an upload sets on top of what was measured. */
export type VisualOverrides = Partial<Pick<typeof socialPostVisuals.$inferInsert, "source" | "songUsed" | "audioNote" | "audio">>;

/**
 * Looks, asks, records. Returns what happened, for the counts. `overrides`
 * are written over the measured fields — an upload says where its frames
 * came from and what its sound does and does not show.
 */
export async function analyseOne(
  deps: Pick<VisualSyncDeps, "db" | "anthropic" | "now">,
  account: "own" | "peer",
  post: { id: string; caption: string | null; openingWords?: string | null; visualAttempts: number | null },
  look: () => Promise<Looked | null>,
  errors: string[],
  overrides: VisualOverrides = {},
): Promise<{ outcome: "ok" | "error" | "unavailable"; detail?: string; summary?: string; visualHook?: string | null }> {
  const attempts = (post.visualAttempts ?? 0) + 1;
  const now = deps.now();
  let looked: Looked | null;
  try {
    looked = await look();
  } catch (err) {
    await record(deps, { postId: post.id, account, status: "error", attempts, ...EMPTY, detail: errorText(err).slice(0, 300), analysedAt: now });
    if (attempts >= MAX_VISUAL_ATTEMPTS) errors.push(`Visuals for post ${post.id} could not be read after ${attempts} attempts: ${errorText(err)}`);
    return { outcome: "error", detail: errorText(err).slice(0, 300) };
  }
  if (looked === null) {
    await record(deps, { postId: post.id, account, status: "unavailable", attempts, ...EMPTY, detail: "Instagram gave nothing to look at", analysedAt: now });
    return { outcome: "unavailable" };
  }

  const facts = looked.facts;
  const measured = {
    basis: looked.kind,
    frameTimesMs: looked.frameTimesMs,
    imageCount: looked.images.length,
    audio: looked.audio,
    durationMs: facts?.durationMs ?? null,
    cuts: facts?.cuts ?? null,
    cutsPerMinute: facts?.durationMs ? Math.round((facts.cuts / (facts.durationMs / 60_000)) * 10) / 10 : null,
    meanVolumeDb: facts?.meanVolumeDb !== undefined && facts?.meanVolumeDb !== null && Number.isFinite(facts.meanVolumeDb) ? facts.meanVolumeDb : null,
    contactSheet: looked.sheet,
    source: "api",
    ...overrides,
  };

  const { prompt } = buildVisualPrompt({
    kind: looked.kind, account, caption: post.caption, frameTimesMs: looked.frameTimesMs ?? undefined,
    slideCount: looked.images.length, transcriptOpening: post.openingWords ?? null,
  });
  let detail: string | null = null;
  let parsed = null;
  try {
    const result = await deps.anthropic.generate(prompt, { images: looked.images, maxTokens: 1200, temperature: 0 });
    parsed = parseVisualAnalysis(result.text, looked.kind);
    if (parsed === null) detail = `unreadable answer: ${result.text.slice(0, 200)}`;
  } catch (err) {
    detail = errorText(err).slice(0, 300);
  }

  if (parsed === null) {
    await record(deps, { postId: post.id, account, status: "error", attempts, ...EMPTY, ...measured, contactSheet: null, detail, analysedAt: now });
    if (attempts >= MAX_VISUAL_ATTEMPTS) errors.push(`Visuals for post ${post.id} could not be analysed after ${attempts} attempts: ${detail}`);
    return { outcome: "error", detail: detail ?? "unknown" };
  }
  await record(deps, {
    postId: post.id, account, status: "ok", attempts, ...measured,
    summary: parsed.summary, visualType: parsed.visualType, handDrawn: flag(parsed.handDrawn), onScreenText: parsed.onScreenText,
    firstFrame: parsed.firstFrame, visualHook: parsed.visualHook, faceInFirst2s: flag(parsed.faceInFirst2s),
    productVisible: flag(parsed.productVisible), productFirstSeen: parsed.productFirstSeen, setting: parsed.setting,
    emotion: parsed.emotion, branding: flag(parsed.branding), detail: null, analysedAt: now,
  });
  return { outcome: "ok", summary: parsed.summary, visualHook: parsed.visualHook };
}

export async function syncVisuals(deps: VisualSyncDeps, errors: string[]): Promise<VisualSyncResult> {
  const now = deps.now();
  const out: VisualSyncResult = { analysed: 0, failed: 0, unavailable: 0, failures: [] };
  const count = (postId: string, r: { outcome: "ok" | "error" | "unavailable"; detail?: string }) => {
    if (r.outcome === "ok") out.analysed++;
    else if (r.outcome === "error") {
      out.failed++;
      out.failures.push({ postId, detail: r.detail ?? "unknown" });
    } else out.unavailable++;
  };

  const own = await deps.db
    .select({
      id: socialPosts.id,
      caption: socialPosts.caption,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      transcriptionStatus: socialPosts.transcriptionStatus,
      openingWords: socialPosts.openingWords,
      durationMs: socialPosts.durationMs,
      postVisualStatus: socialPosts.visualStatus,
      visualStatus: socialPostVisuals.status,
      visualAttempts: socialPostVisuals.attempts,
    })
    .from(socialPosts)
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPosts.id))
    .where(and(
      gte(socialPosts.postedAt, new Date(now.getTime() - OWN_VISUAL_DAYS * 86_400_000)),
      sql`${socialPosts.mediaProductType} IS DISTINCT FROM 'STORY'`,
      sql`(${socialPostVisuals.status} IS NULL OR (${socialPostVisuals.status} = 'error' AND ${socialPostVisuals.attempts} < ${MAX_VISUAL_ATTEMPTS}))`,
    ))
    .orderBy(desc(socialPosts.postedAt))
    .limit(OWN_VISUALS_PER_RUN);

  for (const post of own) {
    if (!shouldAnalyseVisual(post.visualStatus === null ? null : { status: post.visualStatus, attempts: post.visualAttempts ?? 0 })) continue;
    let measuredLength: number | null = null;
    let lookedKind: VisualKind | null = null;
    const result = await analyseOne(deps, "own", post, async () => {
      const looked = await lookAtOwn(deps, post);
      measuredLength = looked?.facts?.durationMs ?? null;
      lookedKind = looked?.kind ?? null;
      return looked;
    }, errors);
    // What the post record says: frames seen, or only the cover until
    // someone uploads the video. An upload's `analyzed` is never undone.
    const status = lookedKind === "frames" && result.outcome === "ok" ? "analyzed" : lookedKind === "cover" ? "cover_only" : null;
    const change = {
      ...(status !== null && post.postVisualStatus !== "analyzed" && post.postVisualStatus !== status ? { visualStatus: status } : {}),
      // A reel never transcribed, or transcribed before lengths were kept,
      // gets its length from the video itself.
      ...(post.durationMs === null && measuredLength !== null ? { durationMs: measuredLength } : {}),
    };
    if (Object.keys(change).length > 0) {
      await deps.db.update(socialPosts).set({ ...change, updatedAt: now }).where(eq(socialPosts.id, post.id));
    }
    count(post.id, result);
  }

  const peers = await deps.db
    .select({
      id: socialPeerPosts.id,
      caption: socialPeerPosts.caption,
      mediaType: socialPeerPosts.mediaType,
      mediaProductType: socialPeerPosts.mediaProductType,
      imageUrls: socialPeerPosts.imageUrls,
      visualStatus: socialPostVisuals.status,
      visualAttempts: socialPostVisuals.attempts,
    })
    .from(socialPeerPosts)
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPeerPosts.id))
    .where(and(
      gte(socialPeerPosts.postedAt, new Date(now.getTime() - PEER_VISUAL_DAYS * 86_400_000)),
      sql`(${socialPostVisuals.status} IS NULL OR (${socialPostVisuals.status} = 'error' AND ${socialPostVisuals.attempts} < ${MAX_VISUAL_ATTEMPTS}))`,
    ))
    .orderBy(desc(socialPeerPosts.postedAt))
    .limit(PEER_VISUALS_PER_RUN);

  for (const post of peers) {
    if (!shouldAnalyseVisual(post.visualStatus === null ? null : { status: post.visualStatus, attempts: post.visualAttempts ?? 0 })) continue;
    count(post.id, await analyseOne(deps, "peer", post, () => lookAtPeer(deps, post), errors));
  }
  return out;
}
