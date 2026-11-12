import { describe, it, expect, vi } from "vitest";
import { createReelDownloader, pickBestVideo, REEL_DOWNLOADER_HOST } from "@/integrations/reel-downloader";

const KEY = "secret-key-123";
// The shape of a real response from the RapidAPI console, links shortened.
const SUCCESS = {
  title: "happy thanksgiving", source: "instagram", server: "zivofly", thumbnail: "https://cdn/thumb.jpg", duration: 0, message: "success", subtitles: [],
  formats: [
    { url: "https://cdn/video-720.mp4", filesize: "—", quality: "720x1280p", acodec: "aac", vcodec: "h264", ext: "mp4", protocol: "https" },
    { url: "https://cdn/audio.m4a", filesize: "—", quality: "audio_only", acodec: "mp3", vcodec: "none", ext: "m4a", protocol: "https" },
  ],
};
const RATE = { "x-ratelimit-requests-limit": "3", "x-ratelimit-requests-remaining": "2", "x-ratelimit-requests-reset": "2590961" };

function respond(body: unknown, status = 200, headers: Record<string, string> = RATE) {
  return vi.fn().mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
}

describe("pickBestVideo", () => {
  it("takes the largest mp4 with a video stream and skips audio-only", () => {
    expect(pickBestVideo([
      { url: "a", quality: "audio_only", vcodec: "none", ext: "m4a" },
      { url: "small", quality: "480x854p", vcodec: "h264", ext: "mp4" },
      { url: "big", quality: "1080x1920p", vcodec: "h264", ext: "mp4" },
    ])).toEqual({ url: "big", quality: "1080x1920p" });
  });

  it("falls back to the first mp4 when no quality can be read", () => {
    expect(pickBestVideo([{ url: "only", quality: "hd", vcodec: "h264", ext: "mp4" }])).toEqual({ url: "only", quality: "hd" });
  });

  it("finds nothing in a list with no video", () => {
    expect(pickBestVideo([{ url: "a", quality: "audio_only", vcodec: "none", ext: "m4a" }])).toBeNull();
    expect(pickBestVideo("nope" as never)).toBeNull();
  });
});

describe("resolve", () => {
  it("posts the reel link as the form field the API takes, with the key in a header only", async () => {
    const fetchImpl = respond(SUCCESS);
    await createReelDownloader({ apiKey: KEY, fetchImpl }).resolve("https://www.instagram.com/reel/DRkzBLRktBK/");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://${REEL_DOWNLOADER_HOST}/download.php`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-rapidapi-key": KEY, "x-rapidapi-host": REEL_DOWNLOADER_HOST });
    expect((init.body as FormData).get("url")).toBe("https://www.instagram.com/reel/DRkzBLRktBK/");
    expect(String(url)).not.toContain(KEY);
  });

  it("returns the best video link and the quota left", async () => {
    const r = await createReelDownloader({ apiKey: KEY, fetchImpl: respond(SUCCESS) }).resolve("https://www.instagram.com/reel/x/");
    expect(r).toEqual({ ok: true, videoUrl: "https://cdn/video-720.mp4", quality: "720x1280p", rate: { limit: 3, remaining: 2, resetSeconds: 2590961 } });
  });

  it("calls a 429 the rate limit", async () => {
    const r = await createReelDownloader({ apiKey: KEY, fetchImpl: respond({ message: "You have exceeded the MONTHLY quota" }, 429, { "x-ratelimit-requests-remaining": "0" }) }).resolve("u");
    expect(r).toMatchObject({ ok: false, reason: "rate-limited", rate: { remaining: 0 } });
  });

  it("calls any other failed status an API error", async () => {
    const r = await createReelDownloader({ apiKey: KEY, fetchImpl: respond("Server error", 500, {}) }).resolve("u");
    expect(r).toMatchObject({ ok: false, reason: "api-error", detail: expect.stringMatching(/500/) });
  });

  it("calls a reply that is not success, or has no video, no video", async () => {
    expect(await createReelDownloader({ apiKey: KEY, fetchImpl: respond({ message: "Media not found" }) }).resolve("u")).toMatchObject({ ok: false, reason: "no-video", detail: expect.stringMatching(/Media not found/) });
    expect(await createReelDownloader({ apiKey: KEY, fetchImpl: respond({ ...SUCCESS, formats: [SUCCESS.formats[1]] }) }).resolve("u")).toMatchObject({ ok: false, reason: "no-video" });
  });

  it("calls an unreadable reply an API error", async () => {
    expect(await createReelDownloader({ apiKey: KEY, fetchImpl: respond("<html>") }).resolve("u")).toMatchObject({ ok: false, reason: "api-error" });
  });

  // A failure message travels to logs, Slack and the dashboard.
  it("never repeats the key in an error", async () => {
    const r = await createReelDownloader({ apiKey: KEY, fetchImpl: respond(`bad key ${KEY}`, 403, {}) }).resolve("u");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("reports a network failure as an API error without throwing", async () => {
    const r = await createReelDownloader({ apiKey: KEY, fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNRESET")) }).resolve("u");
    expect(r).toMatchObject({ ok: false, reason: "api-error", detail: expect.stringMatching(/ECONNRESET/) });
  });
});
