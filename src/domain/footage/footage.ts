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
  /** Null on rows recorded before content hashes were kept. */
  contentHash: string | null;
  transcriptionStatus: TranscriptionStatus | null;
  transcriptionAttempts: number;
}

export type FootageAction =
  | { action: "transcribe"; reason: "new" | "replaced" | "retry" }
  | { action: "skip"; reason: "settled" | "attempts-exhausted" | "unchanged" };

/**
 * What to do with one file.
 *
 * A replaced file resets the question entirely — the previous outcome
 * described different bytes. That is the one case where a `no-audio` clip is
 * tried again, and it has to be, or re-uploading a fixed export would be
 * ignored forever.
 *
 * Replacement is judged on the content hash when both sides have one, because
 * the rev is not evidence of new bytes: it can change when a file is moved,
 * and a move must not buy a second transcription. Rows from before content
 * hashes were kept fall back to the rev.
 */
export function planFootage(
  entry: DropboxFileEntry,
  known: KnownFootage | undefined,
): FootageAction {
  if (known === undefined) return { action: "transcribe", reason: "new" };
  const replaced = known.contentHash !== null && entry.contentHash !== null
    ? known.contentHash !== entry.contentHash
    : known.rev !== entry.rev;
  if (replaced) return { action: "transcribe", reason: "replaced" };

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

/** A row of the `footage` table, as far as reconciling it needs. */
export interface StoredFootage extends KnownFootage {
  /** Null on rows recorded before file IDs were kept. */
  dropboxId: string | null;
  path: string;
}

export interface FootageMatch {
  entry: DropboxFileEntry;
  /** The row this file already has, or undefined for a file never seen. */
  known: StoredFootage | undefined;
  /** The row predates file IDs and is being claimed by this file now. */
  adopted: boolean;
  /** The file is at a different path than its row records. */
  moved: boolean;
}

export interface FootageReconciliation {
  matches: FootageMatch[];
  /** Rows for files that are no longer in the folder. */
  remove: StoredFootage[];
}

/**
 * Pairs every media file in the folder with its row, and finds the rows whose
 * file has gone (#13).
 *
 * Files are identified by Dropbox file ID, which survives a move or a rename,
 * so reorganising the folder updates rows rather than creating new ones. A row
 * whose ID is not in the folder is removed — the folder is the truth, and a
 * transcript for a deleted clip is a search result pointing at nothing.
 *
 * Rows recorded before IDs were kept have none. Such a row is adopted by the
 * file at its path, or failing that by the one file with its rev: a rev
 * identifies one revision of one file, so it finds a clip that was moved before
 * IDs were recorded. A rev shared by two rows is a guess and is not taken —
 * attaching one clip's transcript to another is worse than transcribing again.
 * An unadopted pre-ID row is removed like any other.
 *
 * Correct only over a COMPLETE listing. Everything absent is removed.
 */
export function reconcileFootage(
  media: DropboxFileEntry[],
  stored: StoredFootage[],
): FootageReconciliation {
  const byId = new Map<string, StoredFootage>();
  const legacy: StoredFootage[] = [];
  for (const row of stored) {
    if (row.dropboxId === null) legacy.push(row);
    else byId.set(row.dropboxId, row);
  }

  const claimed = new Set<StoredFootage>();
  const matches: FootageMatch[] = [];
  const unmatched: DropboxFileEntry[] = [];

  for (const entry of media) {
    const known = byId.get(entry.id);
    if (known) {
      claimed.add(known);
      matches.push({ entry, known, adopted: false, moved: known.path !== entry.path.toLowerCase() });
    } else {
      unmatched.push(entry);
    }
  }

  // Path before rev, across all files, so a clip still where it was is never
  // beaten to its own row by a rev match elsewhere.
  const legacyByPath = new Map(legacy.map((row) => [row.path, row]));
  const pending: DropboxFileEntry[] = [];
  for (const entry of unmatched) {
    const row = legacyByPath.get(entry.path.toLowerCase());
    if (row && !claimed.has(row)) {
      claimed.add(row);
      matches.push({ entry, known: row, adopted: true, moved: false });
    } else {
      pending.push(entry);
    }
  }

  for (const entry of pending) {
    const candidates = entry.rev === ""
      ? []
      : legacy.filter((row) => row.rev === entry.rev);
    const row = candidates.length === 1 && !claimed.has(candidates[0]) ? candidates[0] : undefined;
    if (row) {
      claimed.add(row);
      matches.push({ entry, known: row, adopted: true, moved: row.path !== entry.path.toLowerCase() });
    } else {
      matches.push({ entry, known: undefined, adopted: false, moved: false });
    }
  }

  return { matches, remove: stored.filter((row) => !claimed.has(row)) };
}

/** The `kb_documents.source_file` of a clip's transcript. */
export function footageSourceFile(dropboxId: string): string {
  return `footage:${dropboxId}`;
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
    content: `${footageHeader(input.path)}\n${summaryLine}${tagLine}\nTranscript:\n${input.transcript}`,
    contextPrefix: `Raw footage file ${input.name}`,
  };
}

function footageHeader(path: string): string {
  return `[Footage ${path}]`;
}

/**
 * The document for a clip that moved, rewritten from its existing body.
 *
 * The transcript lives only in the document, so a move rewrites the header
 * rather than rebuilding from parts. Returns null for a body without the
 * header this module writes — one it cannot rewrite without guessing.
 */
export function relocateFootageDocument(
  content: string,
  to: { name: string; path: string },
): { title: string; content: string; contextPrefix: string } | null {
  const newline = content.indexOf("\n");
  if (newline === -1 || !/^\[Footage .*\]$/.test(content.slice(0, newline))) return null;
  return {
    title: `Footage: ${to.name}`,
    content: `${footageHeader(to.path)}${content.slice(newline)}`,
    contextPrefix: `Raw footage file ${to.name}`,
  };
}
