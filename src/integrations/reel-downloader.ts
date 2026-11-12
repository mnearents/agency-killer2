/**
 * RapidAPI "Instagram Downloader" (instagram-downloader51) — the seam.
 *
 * Instagram's own API withholds the video of reels with licensed music, and
 * of every other account's reels. This third-party service resolves a reel's
 * public link to a video file. It works by scraping Instagram, so it can
 * break or disappear without notice: every call is counted and its outcome
 * kept (`social_downloads`), which is how a broken service shows.
 *
 * The request and response are as observed in RapidAPI's console, nothing
 * more: POST /download.php with the reel link as the multipart field `url`;
 * a JSON body whose `message` is "success" and whose `formats` list holds
 * mp4 entries (`quality` like "720x1280p", `vcodec`) and an audio-only one.
 * `filesize` ("—") and `duration` (0) carry nothing and are not read. The
 * quota left is in the `x-ratelimit-requests-*` headers. A 429 is taken as
 * the rate limit; the console showed no error response to confirm its shape.
 *
 * The key travels in a header only and is scrubbed from every error, which
 * reaches logs, Slack and the dashboard.
 */

import { saveStreamToTemp } from "./media-download";

export const REEL_DOWNLOADER_HOST = "instagram-downloader51.p.rapidapi.com";

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  /** Seconds until the quota resets, as the API said at the time of the call. */
  resetSeconds: number | null;
}

export type ResolveResult =
  | { ok: true; videoUrl: string; quality: string | null; rate: RateLimitState }
  | { ok: false; reason: "rate-limited" | "api-error" | "no-video"; detail: string; rate: RateLimitState };

export interface DownloadedFile {
  path: string;
  bytes: number;
  contentType: string;
  remove: () => Promise<void>;
}

export interface ReelDownloaderClient {
  /** The reel's video link. Never throws: failure is a reason. */
  resolve(permalink: string): Promise<ResolveResult>;
  /** Streams a video link to a temporary file; throws `code: "TOO_LARGE"` past the limit. */
  download(url: string, maxBytes: number): Promise<DownloadedFile>;
}

export interface ReelDownloaderConfig {
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const num = (v: string | null) => (v === null || v.trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function rateOf(headers: Headers): RateLimitState {
  return {
    limit: num(headers.get("x-ratelimit-requests-limit")),
    remaining: num(headers.get("x-ratelimit-requests-remaining")),
    resetSeconds: num(headers.get("x-ratelimit-requests-reset")),
  };
}

/** The largest mp4 with a video stream; null when there is none. */
export function pickBestVideo(formats: unknown): { url: string; quality: string | null } | null {
  if (!Array.isArray(formats)) return null;
  const videos = formats
    .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
    .filter((f) => typeof f.url === "string" && f.ext === "mp4" && f.vcodec !== "none")
    .map((f) => {
      const quality = typeof f.quality === "string" ? f.quality : null;
      const size = quality?.match(/^(\d+)x(\d+)/);
      return { url: f.url as string, quality, pixels: size ? Number(size[1]) * Number(size[2]) : 0 };
    });
  if (videos.length === 0) return null;
  const best = videos.reduce((a, b) => (b.pixels > a.pixels ? b : a));
  return { url: best.url, quality: best.quality };
}

export function createReelDownloader(config: ReelDownloaderConfig): ReelDownloaderClient {
  const doFetch = config.fetchImpl ?? fetch;
  const scrub = (text: string) => (config.apiKey ? text.split(config.apiKey).join("[key]") : text).slice(0, 300);
  const empty: RateLimitState = { limit: null, remaining: null, resetSeconds: null };

  return {
    async resolve(permalink) {
      const body = new FormData();
      body.set("url", permalink);
      let res: Response;
      try {
        res = await doFetch(`https://${REEL_DOWNLOADER_HOST}/download.php`, {
          method: "POST",
          headers: { accept: "application/json", "x-rapidapi-key": config.apiKey, "x-rapidapi-host": REEL_DOWNLOADER_HOST },
          body,
        });
      } catch (err) {
        return { ok: false, reason: "api-error", detail: scrub(err instanceof Error ? err.message : String(err)), rate: empty };
      }
      const rate = rateOf(res.headers);
      const text = await res.text().catch(() => "");
      if (res.status === 429) return { ok: false, reason: "rate-limited", detail: scrub(`429 ${text}`), rate };
      if (!res.ok) return { ok: false, reason: "api-error", detail: scrub(`${res.status} ${text}`), rate };

      let json: Record<string, unknown>;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        json = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "api-error", detail: scrub(`unreadable reply: ${text}`), rate };
      }
      if (json.message !== "success") return { ok: false, reason: "no-video", detail: scrub(`message: ${String(json.message ?? "(none)")}`), rate };
      const best = pickBestVideo(json.formats);
      if (!best) return { ok: false, reason: "no-video", detail: "No mp4 with video in the reply", rate };
      return { ok: true, videoUrl: best.url, quality: best.quality, rate };
    },

    async download(url, maxBytes) {
      const res = await doFetch(url);
      if (!res.ok || !res.body) throw new Error(`Video download failed: ${res.status}`);
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      const saved = await saveStreamToTemp(res.body, maxBytes, "mp4");
      return { ...saved, contentType };
    },
  };
}
