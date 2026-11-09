/**
 * Downloading Instagram's media for analysis, and parking a video on disk for
 * ffmpeg. Instagram's CDN links are signed and expire, so they are fetched
 * soon after they are read.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Larger than any reel Instagram serves; a guard against the unexpected. */
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export interface FetchedMedia {
  data: Buffer;
  contentType: string;
}

export async function fetchMedia(url: string, maxBytes = MAX_MEDIA_BYTES): Promise<FetchedMedia> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Media download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Media is ${declared} bytes, over the ${maxBytes} limit`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error(`Media is ${data.length} bytes, over the ${maxBytes} limit`);
  return { data, contentType: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() };
}

/** Writes bytes to a fresh temporary directory; `remove` deletes it. */
export async function writeTemp(data: Buffer, extension: string): Promise<{ path: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "media-"));
  const path = join(dir, `media.${extension}`);
  await writeFile(path, data);
  return { path, remove: () => rm(dir, { recursive: true, force: true }) };
}
