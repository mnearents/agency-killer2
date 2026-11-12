import { describe, it, expect } from "vitest";
import { frameTimes, parseProbe, parseMeanVolume, countSceneCuts, MAX_FRAMES } from "@/integrations/video-frames";

describe("frameTimes", () => {
  // The hook lives in the first seconds, so they are sampled densely.
  it("takes 0, 1, 2 and 3 seconds, then every 3 seconds, within the video", () => {
    expect(frameTimes(10_000)).toEqual([0, 1000, 2000, 3000, 6000, 9000]);
  });

  it("caps a long video so one reel cannot send a hundred frames", () => {
    const t = frameTimes(600_000);
    expect(t).toHaveLength(MAX_FRAMES);
    expect(t.slice(0, 4)).toEqual([0, 1000, 2000, 3000]);
  });

  it("keeps a frame inside a very short clip", () => {
    expect(frameTimes(1500)).toEqual([0, 1000]);
  });

  it("takes the first frame when the length is unknown", () => {
    expect(frameTimes(null)).toEqual([0]);
  });
});

describe("parseProbe", () => {
  it("reads the length and whether there is an audio stream", () => {
    const json = JSON.stringify({ format: { duration: "21.433" }, streams: [{ codec_type: "video" }, { codec_type: "audio" }] });
    expect(parseProbe(json)).toEqual({ durationMs: 21_433, hasAudio: true });
  });

  it("reports an unreadable length as unknown, not zero", () => {
    expect(parseProbe(JSON.stringify({ format: {}, streams: [{ codec_type: "video" }] }))).toEqual({ durationMs: null, hasAudio: false });
  });
});

describe("parseMeanVolume", () => {
  it("reads volumedetect's mean volume", () => {
    expect(parseMeanVolume("[Parsed_volumedetect_0 @ 0x1] mean_volume: -23.4 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -2.0 dB")).toBe(-23.4);
  });

  it("is null when there is none", () => {
    expect(parseMeanVolume("no audio here")).toBeNull();
  });
});

describe("countSceneCuts", () => {
  it("counts the frames the scene filter passed", () => {
    const stderr = [
      "[Parsed_showinfo_1 @ 0x1] n:   0 pts:  45045 pts_time:1.5015 duration:1001",
      "[Parsed_showinfo_1 @ 0x1] n:   1 pts: 180180 pts_time:6.006 duration:1001",
      "frame=    2 fps=0.0 q=-0.0 Lsize=N/A",
    ].join("\n");
    expect(countSceneCuts(stderr)).toBe(2);
  });
});

// A reel's sound can run past its picture: the container's length is the
// audio's, and a frame asked for after the last picture is never written.
describe("ffmpeg frames past the end of the picture", () => {
  it("returns the frames the picture has, in order, instead of failing the reel", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createFfmpegToolkit } = await import("@/integrations/video-frames");
    const dir = mkdtempSync(join(tmpdir(), "short-picture-"));
    const file = join(dir, "reel.mp4");
    try {
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", file]);
      const video = createFfmpegToolkit();
      const facts = await video.inspect(file);
      expect(facts.durationMs).toBeGreaterThan(7000);
      const frames = await video.frames(file, frameTimes(facts.durationMs));
      expect(frames).toHaveLength(2);
      expect(frames.every((f) => f[0] === 0xff && f[1] === 0xd8)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
