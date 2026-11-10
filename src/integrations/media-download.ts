/**
 * Downloading Instagram's media for analysis, and parking a video on disk for
 * ffmpeg. Instagram's CDN links are signed and expire, so they are fetched
 * soon after they are read.
 */

import { createWriteStream } from "node:fs";
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

/**
 * Streams a request body to a fresh temporary file, counting bytes as they
 * arrive: a client can declare any Content-Length, so the cap is enforced on
 * what is actually sent. Past it, the file is deleted and the error carries
 * `code: "TOO_LARGE"`.
 */
export async function saveStreamToTemp(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  extension: string,
): Promise<{ path: string; bytes: number; remove: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "upload-"));
  const path = join(dir, `upload.${extension}`);
  const remove = () => rm(dir, { recursive: true, force: true });
  const out = createWriteStream(path);
  let bytes = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw Object.assign(new Error(`Upload is over ${maxBytes} bytes`), { code: "TOO_LARGE" });
      }
      if (!out.write(value)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    return { path, bytes, remove };
  } catch (err) {
    out.destroy();
    await remove();
    throw err;
  }
}
