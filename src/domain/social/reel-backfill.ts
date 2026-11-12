/**
 * Downloads reels Instagram's API will not give the video of — Tara's
 * licensed-music reels, teachers' and standout peers' — through the
 * downloader (RapidAPI), and runs each through the same pipeline a manual
 * upload uses (`analyseUploadedReel`, origin `api_backfill`).
 *
 * One reel at a time, a pause between calls, in the order and within the
 * limits `planDownloads` sets; a rate-limit reply stops the run and leaves the
 * rest queued. Every call is a `social_downloads` row with what came of it
 * and the quota the API reported. A reel that fails stays cover-only and on
 * the upload page; after three failures it is left for a manual upload. The
 * file is deleted whatever happens — only the analysis is kept.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialDownloads } from "@/db/schema";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { AssemblyAiClient } from "@/integrations/assemblyai";
import type { EmbeddingClient } from "@/integrations/openai";
import type { RateLimitState, ReelDownloaderClient } from "@/integrations/reel-downloader";
import type { VideoToolkit } from "@/integrations/video-frames";
import { planDownloads, type DownloadAccount, type DownloadLimits, type DownloadUsage } from "./download-plan";
import { getDownloadQueue, getDownloadUsage } from "./download-queries";
import { analyseUploadedReel } from "./upload";

export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MIN_VIDEO_BYTES = 100 * 1024;
/** Between calls, so a run never bursts against the API. */
export const DOWNLOAD_PAUSE_MS = 3000;

export interface ReelDownloadDeps {
  db: Db;
  anthropic: AnthropicClient;
  video: VideoToolkit;
  downloader: ReelDownloaderClient;
  transcriber?: AssemblyAiClient;
  embeddingClient?: EmbeddingClient;
  limits: DownloadLimits;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export type FetchedReel =
  | { ok: true; path: string; quality: string | null; remove: () => Promise<void>; rate: RateLimitState }
  | { ok: false; reason: "rate-limited" | "api-error" | "no-video" | "bad-file"; detail: string; rate: RateLimitState };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A reel's video, on disk and checked: the link is downloaded at once (these
 * links expire), must be served as video, be over 100KB and under 500MB, and
 * have a length ffprobe can read. A file that fails is deleted.
 */
export async function fetchReelVideo(deps: Pick<ReelDownloadDeps, "downloader" | "video">, permalink: string): Promise<FetchedReel> {
  const resolved = await deps.downloader.resolve(permalink);
  if (!resolved.ok) return resolved;
  const rate = resolved.rate;
  let file;
  try {
    file = await deps.downloader.download(resolved.videoUrl, MAX_VIDEO_BYTES);
  } catch (err) {
    const tooLarge = (err as { code?: string }).code === "TOO_LARGE";
    return { ok: false, reason: "bad-file", detail: tooLarge ? "Video is over 500MB" : errorText(err).slice(0, 300), rate };
  }
  const reject = async (detail: string): Promise<FetchedReel> => {
    await file.remove();
    return { ok: false, reason: "bad-file", detail, rate };
  };
  if (!file.contentType.startsWith("video/")) return reject(`Served with content type "${file.contentType || "(none)"}", not video`);
  if (file.bytes < MIN_VIDEO_BYTES) return reject(`File too small to be a reel (${file.bytes} bytes)`);
  try {
    const facts = await deps.video.inspect(file.path);
    if (!facts.durationMs) return reject("ffprobe read no length from the file");
  } catch (err) {
    return reject(`ffprobe could not read the file: ${errorText(err).slice(0, 200)}`);
  }
  return { ok: true, path: file.path, quality: resolved.quality, remove: file.remove, rate };
}

export interface ReelDownloadResult {
  postId: string;
  account: DownloadAccount;
  username: string | null;
  permalink: string;
  outcome: string;
  detail: string | null;
  summary?: string;
  visualHook?: string | null;
  transcribed?: boolean;
}

export interface ReelDownloadRun {
  calls: number;
  ok: number;
  failed: number;
  /** Why the run stopped short of its queue, if it did. */
  stopped: "rate-limited" | "plan-limit" | "quota-exhausted" | null;
  /** Reels waiting when the run began, of the accounts asked for — zero is an empty queue, not a run that did nothing. */
  queued: DownloadUsage;
  /** The accounts this run was limited to, if any. */
  only: DownloadAccount | null;
  /** Reels left queued — for next month when a cap or the plan stopped them. */
  deferred: DownloadUsage;
  results: ReelDownloadResult[];
}

export async function runReelDownloads(deps: ReelDownloadDeps, opts: { only?: DownloadAccount; max?: number }): Promise<ReelDownloadRun> {
  const now = deps.now();
  const [queue, { usage, quota }] = await Promise.all([getDownloadQueue(deps.db, now), getDownloadUsage(deps.db, now)]);
  const pick = (account: DownloadAccount, list: typeof queue.own) => (opts.only === undefined || opts.only === account ? list : []);
  const plan = planDownloads({
    own: pick("own", queue.own), teachers: pick("teacher", queue.teachers), peers: pick("peer", queue.peers),
    usage, limits: deps.limits, quota, now, max: opts.max,
  });

  const queued = { own: pick("own", queue.own).length, teacher: pick("teacher", queue.teachers).length, peer: pick("peer", queue.peers).length };
  const run: ReelDownloadRun = { calls: 0, ok: 0, failed: 0, stopped: plan.blocked, queued, only: opts.only ?? null, deferred: plan.deferred, results: [] };
  for (const [i, reel] of plan.planned.entries()) {
    if (i > 0) await deps.sleep(DOWNLOAD_PAUSE_MS);
    const calledAt = deps.now();
    const fetched = await fetchReelVideo(deps, reel.permalink);
    run.calls++;
    const id = crypto.randomUUID();
    await deps.db.insert(socialDownloads).values({
      id, postId: reel.postId, account: reel.account, username: reel.username, calledAt,
      outcome: fetched.ok ? "ok" : fetched.reason, detail: fetched.ok ? null : fetched.detail, quality: fetched.ok ? fetched.quality : null,
      rateLimit: fetched.rate.limit, rateRemaining: fetched.rate.remaining,
      rateResetAt: fetched.rate.resetSeconds === null ? null : new Date(calledAt.getTime() + fetched.rate.resetSeconds * 1000),
    });
    const base = { postId: reel.postId, account: reel.account, username: reel.username, permalink: reel.permalink };

    if (!fetched.ok) {
      run.results.push({ ...base, outcome: fetched.reason, detail: fetched.detail });
      if (fetched.reason === "rate-limited") {
        run.stopped = "rate-limited";
        break;
      }
      run.failed++;
      continue;
    }

    try {
      const analysed = await analyseUploadedReel(deps, { postId: reel.postId, filePath: fetched.path, songUsed: null }, { origin: "api_backfill" });
      if (analysed.ok) {
        run.ok++;
        run.results.push({ ...base, outcome: "ok", detail: null, summary: analysed.summary, visualHook: analysed.visualHook, transcribed: analysed.transcribed });
      } else {
        const outcome = analysed.reason === "manual-upload-exists" ? "manual-upload-exists" : "analysis-failed";
        const detail = analysed.detail ?? analysed.reason;
        await deps.db.update(socialDownloads).set({ outcome, detail }).where(eq(socialDownloads.id, id));
        if (outcome === "analysis-failed") run.failed++;
        run.results.push({ ...base, outcome, detail });
      }
    } catch (err) {
      await deps.db.update(socialDownloads).set({ outcome: "analysis-failed", detail: errorText(err).slice(0, 300) }).where(eq(socialDownloads.id, id));
      run.failed++;
      run.results.push({ ...base, outcome: "analysis-failed", detail: errorText(err).slice(0, 300) });
    } finally {
      await fetched.remove();
    }
  }
  return run;
}
