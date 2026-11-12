/**
 * ffmpeg over a downloaded video: its length, whether it has sound and how
 * loud, how many cuts, and frames at chosen moments — the seam between the
 * reel analysis and the ffmpeg binary (installed on the worker by
 * nixpacks.toml). Counting cuts and measuring sound are arithmetic, so they
 * are done here rather than asked of a model looking at stills.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface VideoFacts {
  durationMs: number | null;
  hasAudio: boolean;
  /** Mean loudness in dB; null without an audio stream. Below SILENT_DB is silence. */
  meanVolumeDb: number | null;
  /** Changes of shot the scene filter detected. */
  cuts: number;
}

export interface VideoToolkit {
  inspect(file: string): Promise<VideoFacts>;
  /** One JPEG per requested time, in order — stopping at the last picture, so possibly fewer. */
  frames(file: string, timesMs: number[]): Promise<Buffer[]>;
  /** The frames tiled into one JPEG, left to right, top to bottom. */
  contactSheet(frames: Buffer[]): Promise<Buffer>;
  /** The sound alone, mono AAC — small enough to hand a transcriber. */
  extractAudio(file: string): Promise<Buffer>;
}

/** Quieter than this on average is silence, not a quiet track. */
export const SILENT_DB = -60;
export const MAX_FRAMES = 16;
const SCENE_THRESHOLD = 0.3;
const FRAME_WIDTH = 512;

/** 0, 1, 2, 3 seconds — the hook — then every 3 seconds, inside the video. */
export function frameTimes(durationMs: number | null): number[] {
  if (durationMs === null) return [0];
  const times: number[] = [];
  for (const t of [0, 1000, 2000, 3000]) if (t < durationMs) times.push(t);
  for (let t = 6000; t < durationMs && times.length < MAX_FRAMES; t += 3000) times.push(t);
  return times.slice(0, MAX_FRAMES);
}

export function parseProbe(json: string): { durationMs: number | null; hasAudio: boolean } {
  const probe = JSON.parse(json) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  const seconds = Number(probe.format?.duration);
  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    hasAudio: (probe.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

export function parseMeanVolume(stderr: string): number | null {
  const m = stderr.match(/mean_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) return null;
  return m[1] === "-inf" ? -Infinity : Number(m[1]);
}

export function countSceneCuts(stderr: string): number {
  return (stderr.match(/showinfo[^\n]*pts_time:/g) ?? []).length;
}

export function createFfmpegToolkit(binaries = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" }): VideoToolkit {
  const big = { maxBuffer: 64 * 1024 * 1024 };
  return {
    async inspect(file) {
      const probe = await run(binaries.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], big);
      const { durationMs, hasAudio } = parseProbe(probe.stdout);
      const scenes = await run(binaries.ffmpeg, ["-hide_banner", "-i", file, "-vf", `select='gt(scene,${SCENE_THRESHOLD})',showinfo`, "-an", "-f", "null", "-"], big);
      let meanVolumeDb: number | null = null;
      if (hasAudio) {
        const vol = await run(binaries.ffmpeg, ["-hide_banner", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"], big);
        meanVolumeDb = parseMeanVolume(vol.stderr);
      }
      return { durationMs, hasAudio, meanVolumeDb, cuts: countSceneCuts(scenes.stderr) };
    },

    async frames(file, timesMs) {
      const dir = await mkdtemp(join(tmpdir(), "frames-"));
      try {
        const out: Buffer[] = [];
        for (const [i, t] of timesMs.entries()) {
          const path = join(dir, `f${i}.jpg`);
          try {
            await run(binaries.ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", (t / 1000).toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${FRAME_WIDTH}:-2`, "-q:v", "4", "-y", path], big);
            out.push(await readFile(path));
          } catch (err) {
            // Past the last picture (sound can outlast it): ffmpeg errors or
            // writes nothing, depending on its version. The frames before it
            // stand; a video with no frame at all is still a failure.
            if (out.length === 0) throw err;
            break;
          }
        }
        return out;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async extractAudio(file) {
      const dir = await mkdtemp(join(tmpdir(), "audio-"));
      try {
        const path = join(dir, "audio.m4a");
        await run(binaries.ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", "-y", path], big);
        return await readFile(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },

    async contactSheet(frames) {
      const dir = await mkdtemp(join(tmpdir(), "sheet-"));
      try {
        for (const [i, f] of frames.entries()) await writeFile(join(dir, `f${String(i).padStart(2, "0")}.jpg`), f);
        const cols = Math.min(4, frames.length);
        const rows = Math.ceil(frames.length / cols);
        const path = join(dir, "sheet.jpg");
        await run(binaries.ffmpeg, ["-hide_banner", "-loglevel", "error", "-framerate", "1", "-i", join(dir, "f%02d.jpg"), "-vf", `scale=240:-2,tile=${cols}x${rows}:padding=4:color=white`, "-frames:v", "1", "-q:v", "5", "-y", path], big);
        return await readFile(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
