/**
 * A reel uploaded by hand, for the reels Instagram will not hand over.
 *
 * Instagram's API omits the video of reels carrying licensed music, so the
 * sync sees only their cover (`visual_status = 'cover_only'`). Matt downloads
 * the reel from Instagram and uploads it at /social/uploads; it is analysed
 * here by the SAME pipeline the sync uses for reels with video
 * (`lookAtVideoFile` and `analyseOne` from `visual-sync.ts`), recorded as
 * `source = 'manual_upload'`, and the post becomes `analyzed`.
 *
 * Instagram's download can drop or replace licensed music, so the sound
 * measured is the file's, not necessarily the posted track's: the post keeps
 * `licensed-music-likely` as its sound and the row says why.
 *
 * A peer's reel can be uploaded too: Instagram never gives another account's
 * video, so without a copy it is seen by its cover alone. Its row is the
 * peer's (`account = 'peer'`), its sound is what the file measured — the
 * video was withheld because it is someone else's, not because of its music
 * — and its transcript stays on the peer post, out of the knowledge base.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kbDocuments, socialLessonRuns, socialPeerPosts, socialPostAnalyses, socialPosts, socialPostVisuals } from "@/db/schema";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { AssemblyAiClient, TranscriptResult } from "@/integrations/assemblyai";
import type { EmbeddingClient } from "@/integrations/openai";
import { SILENT_DB, type VideoFacts, type VideoToolkit } from "@/integrations/video-frames";
import { openingWords } from "./review";
import { classifyTranscription } from "./transcription";
import { analyseOne, lookAtVideoFile, type Looked } from "./visual-sync";

export interface UploadDeps {
  db: Db;
  anthropic: AnthropicClient;
  video: VideoToolkit;
  /** Without it, speech in the upload is not transcribed — said in the result. */
  transcriber?: AssemblyAiClient;
  embeddingClient?: EmbeddingClient;
  now: () => Date;
}

export type UploadResult =
  | {
      ok: true;
      /** Whose reel it was: Tara's, or a tracked peer's. */
      account: "own" | "peer";
      summary: string;
      visualHook: string | null;
      durationMs: number | null;
      cuts: number | null;
      transcribed: boolean;
      transcriptError: string | null;
      audioNote: string;
    }
  | { ok: false; reason: "not-found" | "not-a-reel" | "unreadable-video" | "analysis-failed"; detail?: string };

export const UPLOAD_AUDIO_NOTE =
  "Sound measured from the uploaded file, which can differ from the posted reel: Instagram's download may drop or replace licensed music.";

export const PEER_UPLOAD_AUDIO_NOTE =
  "Sound measured from the uploaded file, which can differ from the posted reel: Instagram's download or a screen recording may drop or replace its music.";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isReel = (p: { mediaType: string; mediaProductType: string | null }) => p.mediaType === "VIDEO" || p.mediaProductType === "REELS";

export async function analyseUploadedReel(
  deps: UploadDeps,
  input: { postId: string; filePath: string; songUsed: string | null },
): Promise<UploadResult> {
  const now = deps.now();
  const [post] = await deps.db
    .select({
      id: socialPosts.id,
      caption: socialPosts.caption,
      mediaType: socialPosts.mediaType,
      mediaProductType: socialPosts.mediaProductType,
      transcriptionStatus: socialPosts.transcriptionStatus,
      transcriptionAttempts: socialPosts.transcriptionAttempts,
      openingWords: socialPosts.openingWords,
      durationMs: socialPosts.durationMs,
      postedAt: socialPosts.postedAt,
      visualAttempts: socialPostVisuals.attempts,
    })
    .from(socialPosts)
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPosts.id))
    .where(eq(socialPosts.id, input.postId))
    .limit(1);
  if (!post) return analyseUploadedPeerReel(deps, input);
  if (!isReel(post)) return { ok: false, reason: "not-a-reel" };

  // Read before anything is written: a file ffmpeg cannot read is refused
  // whole, rather than leaving half an analysis behind.
  let looked: Looked;
  try {
    looked = await lookAtVideoFile(deps, input.filePath, post.transcriptionStatus);
  } catch (err) {
    return { ok: false, reason: "unreadable-video", detail: errorText(err).slice(0, 300) };
  }
  const facts = looked.facts!;

  const transcript = await transcribeUpload(deps, post, input.filePath, facts, now);
  const opening = transcript.openingWords ?? post.openingWords;

  const errors: string[] = [];
  const result = await analyseOne(deps, "own", { ...post, openingWords: opening }, async () => looked, errors, {
    source: "manual_upload",
    songUsed: input.songUsed,
    audioNote: UPLOAD_AUDIO_NOTE,
    // The posted reel's sound: Instagram withheld its video for licensed music.
    audio: "licensed-music-likely",
  });
  if (result.outcome !== "ok") return { ok: false, reason: "analysis-failed", detail: result.detail };

  await deps.db
    .update(socialPosts)
    .set({ visualStatus: "analyzed", ...(post.durationMs === null && facts.durationMs !== null ? { durationMs: facts.durationMs } : {}), updatedAt: now })
    .where(eq(socialPosts.id, post.id));

  return {
    ok: true,
    account: "own",
    summary: result.summary ?? "",
    visualHook: result.visualHook ?? null,
    durationMs: facts.durationMs,
    cuts: facts.cuts,
    transcribed: transcript.transcribed,
    transcriptError: transcript.error,
    audioNote: UPLOAD_AUDIO_NOTE,
  };
}

/** A tracked peer's reel: frames, the file's own sound, and its words kept on the peer post. */
async function analyseUploadedPeerReel(
  deps: UploadDeps,
  input: { postId: string; filePath: string; songUsed: string | null },
): Promise<UploadResult> {
  const [post] = await deps.db
    .select({
      id: socialPeerPosts.id,
      caption: socialPeerPosts.caption,
      mediaType: socialPeerPosts.mediaType,
      mediaProductType: socialPeerPosts.mediaProductType,
      transcript: socialPeerPosts.transcript,
      openingWords: socialPeerPosts.openingWords,
      visualAttempts: socialPostVisuals.attempts,
    })
    .from(socialPeerPosts)
    .leftJoin(socialPostVisuals, eq(socialPostVisuals.postId, socialPeerPosts.id))
    .where(eq(socialPeerPosts.id, input.postId))
    .limit(1);
  if (!post) return { ok: false, reason: "not-found" };
  if (!isReel(post)) return { ok: false, reason: "not-a-reel" };

  let looked: Looked;
  try {
    looked = await lookAtVideoFile(deps, input.filePath, post.transcript ? "ok" : null);
  } catch (err) {
    return { ok: false, reason: "unreadable-video", detail: errorText(err).slice(0, 300) };
  }
  const facts = looked.facts!;

  const words = post.transcript ? { transcribed: false, transcript: post.transcript, openingWords: post.openingWords, error: null } : await transcribePeerUpload(deps, input.filePath, facts);
  if (words.transcribed) {
    await deps.db
      .update(socialPeerPosts)
      .set({ transcript: words.transcript, openingWords: words.openingWords })
      .where(eq(socialPeerPosts.id, post.id));
    await deps.db.update(socialPostAnalyses).set({ status: "stale", attempts: 0 }).where(eq(socialPostAnalyses.postId, post.id));
    // A teacher's reel teaches mostly in what is said: read its lessons again.
    await deps.db.update(socialLessonRuns).set({ status: "stale", attempts: 0 }).where(eq(socialLessonRuns.postId, post.id));
  }
  const audio = words.transcript ? "speech" : looked.audio;

  const errors: string[] = [];
  const result = await analyseOne(deps, "peer", { ...post, openingWords: words.openingWords }, async () => looked, errors, {
    source: "manual_upload",
    songUsed: input.songUsed,
    audioNote: PEER_UPLOAD_AUDIO_NOTE,
    audio,
  });
  if (result.outcome !== "ok") return { ok: false, reason: "analysis-failed", detail: result.detail };
  return {
    ok: true,
    account: "peer",
    summary: result.summary ?? "",
    visualHook: result.visualHook ?? null,
    durationMs: facts.durationMs,
    cuts: facts.cuts,
    transcribed: words.transcribed,
    transcriptError: words.error,
    audioNote: PEER_UPLOAD_AUDIO_NOTE,
  };
}

/** Speech in a peer's upload, as text — nothing stored here. */
async function transcribePeerUpload(
  deps: UploadDeps,
  path: string,
  facts: VideoFacts,
): Promise<{ transcribed: boolean; transcript: string | null; openingWords: string | null; error: string | null }> {
  const none = { transcribed: false, transcript: null, openingWords: null, error: null };
  if (!deps.transcriber) return none;
  if (!facts.hasAudio || (facts.meanVolumeDb !== null && facts.meanVolumeDb < SILENT_DB)) return none;
  let raw: TranscriptResult;
  try {
    raw = await deps.transcriber.transcribe(await deps.transcriber.uploadFile(await deps.video.extractAudio(path)));
  } catch (err) {
    return { ...none, error: errorText(err).slice(0, 300) };
  }
  const classified = classifyTranscription(raw);
  if (classified.status !== "ok" || classified.text === null) {
    return { ...none, error: classified.status === "no-audio" ? null : classified.detail };
  }
  return { transcribed: true, transcript: classified.text, openingWords: openingWords(raw.words), error: null };
}

/**
 * Speech in the upload, when there is sound and the reel has no transcript
 * yet. Stored as the sync stores one — a knowledge base document and the
 * opening words — and the post's text analysis is marked stale so the next
 * sync reads its hook from what was said, not the caption alone. A failure
 * here costs the words, never the visual analysis.
 */
async function transcribeUpload(
  deps: UploadDeps,
  post: { id: string; caption: string | null; transcriptionStatus: string | null; transcriptionAttempts: number | null; postedAt: Date },
  path: string,
  facts: VideoFacts,
  now: Date,
): Promise<{ transcribed: boolean; openingWords: string | null; error: string | null }> {
  const none = { transcribed: false, openingWords: null, error: null };
  if (!deps.transcriber || post.transcriptionStatus === "ok") return none;
  if (!facts.hasAudio || (facts.meanVolumeDb !== null && facts.meanVolumeDb < SILENT_DB)) return none;

  let raw: TranscriptResult;
  try {
    const link = await deps.transcriber.uploadFile(await deps.video.extractAudio(path));
    raw = await deps.transcriber.transcribe(link);
  } catch (err) {
    return { ...none, error: errorText(err).slice(0, 300) };
  }
  const classified = classifyTranscription(raw);
  if (classified.status !== "ok" || classified.text === null) {
    return { ...none, error: classified.status === "no-audio" ? null : classified.detail };
  }

  const opening = openingWords(raw.words);
  const postedDate = post.postedAt.toISOString().slice(0, 10);
  const content = `[Reel posted ${postedDate}]\nCaption: ${post.caption ?? "(none)"}\n\nTranscript:\n${classified.text}`;
  let embedding: number[] | null = null;
  if (deps.embeddingClient) {
    try {
      embedding = (await deps.embeddingClient.embed(content)).embedding;
    } catch (err) {
      console.error(`[social:upload] Embedding failed for ${post.id}: ${errorText(err)}`);
    }
  }
  await deps.db.insert(kbDocuments).values({
    title: `Reel: ${post.caption ? post.caption.slice(0, 100) : "untitled"} (${postedDate})`,
    content,
    category: "social-transcript",
    sourceFile: `ig:${post.id}`,
    contentHash: crypto.randomUUID(),
    chunkIndex: 0,
    totalChunks: 1,
    contextPrefix: `Instagram Reel from ${postedDate} (from an uploaded copy)`,
    documentDate: post.postedAt,
    embedding,
  });
  await deps.db
    .update(socialPosts)
    .set({
      transcriptionStatus: "ok",
      transcriptionAttempts: (post.transcriptionAttempts ?? 0) + 1,
      transcriptionAttemptedAt: now,
      openingWords: opening,
      updatedAt: now,
    })
    .where(eq(socialPosts.id, post.id));
  await deps.db.update(socialPostAnalyses).set({ status: "stale", attempts: 0 }).where(eq(socialPostAnalyses.postId, post.id));
  return { transcribed: true, openingWords: opening, error: null };
}
