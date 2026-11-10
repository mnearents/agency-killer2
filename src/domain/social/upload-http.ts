/**
 * The HTTP side of a manual reel upload (/api/social/upload/<media id>).
 *
 * The file is the PUT body itself, streamed to disk — never read whole into
 * memory, never through an MCP call. It is a write surface on a public
 * dashboard, so it sits behind the same Basic auth as the cost form and
 * fails closed when no password is configured. Credentials, ID, size and type
 * are all checked before a byte of the body is read.
 */

import { checkBasicAuth, CHALLENGE_HEADER, type BasicAuthConfig } from "@/lib/basic-auth";
import type { UploadResult } from "./upload";

/** Instagram's own download of a reel is far smaller; this is a ceiling. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "application/octet-stream"];
const MEDIA_ID = /^\d{5,30}$/;
const MAX_SONG = 200;

export interface UploadHttpDeps {
  auth: BasicAuthConfig;
  /** Streams the body to a temporary file; throws `code: "TOO_LARGE"` past the limit. */
  saveBody: (body: ReadableStream<Uint8Array>, maxBytes: number) => Promise<{ path: string; bytes: number; remove: () => Promise<void> }>;
  analyse: (input: { postId: string; filePath: string; songUsed: string | null }) => Promise<UploadResult>;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function refuse(request: Request, auth: BasicAuthConfig): Response | null {
  const result = checkBasicAuth(request.headers.get("authorization"), auth);
  if (result.ok) return null;
  console.error(`[social:upload] refused: ${result.reason}`);
  if (result.reason === "not_configured") return json({ error: "Uploads are not configured on this deployment." }, 503);
  return json({ error: "Authentication required." }, 401, CHALLENGE_HEADER);
}

/** Called by the page before a file is chosen, so the browser asks for the password first. */
export async function handleUploadCheck(request: Request, auth: BasicAuthConfig): Promise<Response> {
  return refuse(request, auth) ?? json({ ok: true, maxBytes: MAX_UPLOAD_BYTES }, 200);
}

const STATUS: Record<Exclude<UploadResult, { ok: true }>["reason"], number> = {
  "not-found": 404,
  "not-a-reel": 422,
  "unreadable-video": 422,
  "analysis-failed": 502,
};

export async function handleReelUpload(request: Request, postId: string, deps: UploadHttpDeps): Promise<Response> {
  const refusal = refuse(request, deps.auth);
  if (refusal) return refusal;
  if (!MEDIA_ID.test(postId)) return json({ ok: false, reason: "not-found" }, 404);

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return json({ ok: false, reason: "too-large", maxBytes: MAX_UPLOAD_BYTES }, 413);
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!VIDEO_TYPES.includes(type)) return json({ ok: false, reason: "not-a-video", detail: "Upload an .mp4 or .mov file." }, 415);
  if (!request.body) return json({ ok: false, reason: "empty" }, 400);

  const song = new URL(request.url).searchParams.get("song")?.trim().slice(0, MAX_SONG) ?? "";

  let saved: Awaited<ReturnType<UploadHttpDeps["saveBody"]>>;
  try {
    saved = await deps.saveBody(request.body, MAX_UPLOAD_BYTES);
  } catch (err) {
    if ((err as { code?: string }).code === "TOO_LARGE") return json({ ok: false, reason: "too-large", maxBytes: MAX_UPLOAD_BYTES }, 413);
    throw err;
  }
  try {
    console.log(`[social:upload] ${postId}: ${saved.bytes} bytes received, analysing`);
    const result = await deps.analyse({ postId, filePath: saved.path, songUsed: song === "" ? null : song });
    if (result.ok) {
      console.log(`[social:upload] ${postId}: analysed${result.transcribed ? ", transcribed" : ""}`);
      return json(result, 200);
    }
    console.error(`[social:upload] ${postId}: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    return json(result, STATUS[result.reason]);
  } finally {
    await saved.remove();
  }
}
