/**
 * Which files in `/RAD/Footage` are video, and what to do with each (#13).
 *
 * Pure — no Dropbox, no database, no clock. The sync sequences these.
 */

import type { DropboxFileEntry } from "@/integrations/dropbox";
import {
  shouldAttemptTranscription,
  type TranscriptionStatus,
} from "@/domain/social/transcription";

/**
 * Extensions treated as video.
 *
 * A list rather than "not a known document type", so a file nobody anticipated
 * is skipped and countable instead of being handed to a transcriber that will
 * fail on it. `.mov` and `.mp4` cover a phone and a camera; the rest are here
 * because editors export them.
 */
export const VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"] as const;

/** AssemblyAI accepts audio too, and voice memos belong with the footage. */
export const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".aac"] as const;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isTranscribableMedia(entry: DropboxFileEntry): boolean {
  if (entry.isFolder) return false;
  const ext = extensionOf(entry.name);
  return (
    (VIDEO_EXTENSIONS as readonly string[]).includes(ext) ||
    (AUDIO_EXTENSIONS as readonly string[]).includes(ext)
  );
}

export interface KnownFootage {
  rev: string;
  transcriptionStatus: TranscriptionStatus | null;
  transcriptionAttempts: number;
}

export type FootageAction =
  | { action: "transcribe"; reason: "new" | "replaced" | "retry" }
  | { action: "skip"; reason: "settled" | "attempts-exhausted" | "unchanged" };

/**
 * What to do with one file.
 *
 * A changed Dropbox `rev` means the file was replaced, which resets the
 * question entirely — the previous outcome described different bytes. That is
 * the one case where a `no-audio` clip is tried again, and it has to be, or
 * re-uploading a fixed export would be ignored forever.
 */
export function planFootage(
  entry: DropboxFileEntry,
  known: KnownFootage | undefined,
): FootageAction {
  if (known === undefined) return { action: "transcribe", reason: "new" };
  if (known.rev !== entry.rev) return { action: "transcribe", reason: "replaced" };

  const decision = shouldAttemptTranscription({
    status: known.transcriptionStatus,
    attempts: known.transcriptionAttempts,
  });
  if (decision.attempt) return { action: "transcribe", reason: "retry" };
  return {
    action: "skip",
    reason: decision.reason === "attempts-exhausted" ? "attempts-exhausted" : "settled",
  };
}

/** The prompt that turns a transcript into tags. Pinned so output stays stable. */
export const TAGGING_INSTRUCTION =
  "You are tagging raw marketing footage for a stationery brand so it can be found later. " +
  "From the transcript, return JSON with two fields: `summary`, one sentence describing what " +
  "happens in the clip, and `tags`, 3-8 short lowercase keywords covering the topic, any product " +
  "named, and the format (for example: planner, unboxing, testimonial, tutorial, behind-the-scenes). " +
  "Use only what the transcript supports. Do not guess at what is on screen — you cannot see it.";

export interface FootageTags {
  summary: string;
  tags: string[];
}

/**
 * Parses the tagging response.
 *
 * Returns null rather than throwing or inventing an empty tag set: a clip with
 * no tags because the model returned nonsense and one with no tags because it
 * is silent would otherwise look identical in the table.
 */
export function parseTags(raw: string): FootageTags | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== "")
    : [];

  if (summary === "" && tags.length === 0) return null;
  return { summary, tags: [...new Set(tags)] };
}

/** The knowledge base document body for a clip, so kb_search can find it. */
export function footageDocument(input: {
  name: string;
  path: string;
  summary: string | null;
  tags: string[] | null;
  transcript: string;
}): { title: string; content: string; contextPrefix: string } {
  const tagLine = input.tags && input.tags.length > 0 ? `Tags: ${input.tags.join(", ")}\n` : "";
  const summaryLine = input.summary ? `Summary: ${input.summary}\n` : "";
  return {
    title: `Footage: ${input.name}`,
    // Tags and summary sit in the embedded text on purpose: a search for
    // "unboxing" should find a clip tagged unboxing even when the speaker
    // never says the word.
    content: `[Footage ${input.path}]\n${summaryLine}${tagLine}\nTranscript:\n${input.transcript}`,
    contextPrefix: `Raw footage file ${input.name}`,
  };
}
