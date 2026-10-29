/**
 * A clip's transcript as timed segments — what a cut list is made from.
 *
 * Segments end at a sentence and at any long pause. The pause matters as much
 * as the sentence: mid-sentence silence is where a speaker restarted or lost
 * the line, which is where an editor cuts, and a segment spanning it would
 * hide it.
 */

import { eq, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { footage } from "@/db/schema";

/** A word as stored in `footage.words`, times in milliseconds. */
export interface StoredWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** Silence before this segment — from the start of the clip for the first. */
  gapBeforeMs: number;
  /** The least confident word, so a mumbled line can be found. */
  minConfidence: number;
  words?: TranscriptWord[];
}

/** Silence long enough to start a new segment mid-sentence. */
export const PAUSE_SPLIT_MS = 1500;

const SENTENCE_END = /[.?!]["'”’)\]]*$/;
const ABBREVIATIONS = new Set(["mr.", "mrs.", "ms.", "dr.", "st.", "vs.", "etc.", "e.g.", "i.e."]);

const endsSentence = (word: string) =>
  SENTENCE_END.test(word) && !ABBREVIATIONS.has(word.toLowerCase().replace(/^["'“‘(\[]+/, ""));

export function segmentTranscript(words: StoredWord[], opts: { withWords?: boolean } = {}): TranscriptSegment[] {
  const groups: StoredWord[][] = [];
  let current: StoredWord[] = [];
  for (const word of words) {
    const previous = current.at(-1);
    if (previous && word.start - previous.end >= PAUSE_SPLIT_MS) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    if (endsSentence(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  let lastEnd = 0;
  return groups.map((group) => {
    const segment: TranscriptSegment = {
      startMs: group[0].start,
      endMs: group.at(-1)!.end,
      text: group.map((w) => w.text).join(" "),
      gapBeforeMs: Math.max(0, group[0].start - lastEnd),
      minConfidence: Math.min(...group.map((w) => w.confidence)),
    };
    if (opts.withWords) {
      segment.words = group.map((w) => ({ text: w.text, startMs: w.start, endMs: w.end, confidence: w.confidence }));
    }
    lastEnd = segment.endMs;
    return segment;
  });
}

export interface TranscriptClip {
  id: string | null;
  path: string;
  name: string;
  kind: string;
  transcriptionStatus: string | null;
  transcriptionDetail: string | null;
  durationMs: number | null;
  words: StoredWord[] | null;
}

/** Clips whose Dropbox ID or path is the one given. Paths are not unique. */
export async function findTranscriptClips(db: Db, ref: { id?: string; path?: string }): Promise<TranscriptClip[]> {
  const conditions = [];
  if (ref.id) conditions.push(eq(footage.dropboxId, ref.id));
  if (ref.path) conditions.push(eq(footage.path, normalisePath(ref.path)));
  if (conditions.length === 0) return [];
  return db
    .select({
      id: footage.dropboxId,
      path: footage.path,
      name: footage.name,
      kind: footage.kind,
      transcriptionStatus: footage.transcriptionStatus,
      transcriptionDetail: footage.transcriptionDetail,
      durationMs: footage.durationMs,
      words: footage.words,
    })
    .from(footage)
    .where(or(...conditions))
    .orderBy(footage.dropboxId)
    .limit(5);
}

/** Stored paths are lowercased and rooted. */
export function normalisePath(path: string): string {
  const trimmed = path.trim().toLowerCase();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function footageTranscriptResult(clips: TranscriptClip[], opts: { withWords: boolean }): unknown {
  if (clips.length === 0) {
    return {
      error:
        "No clip matched. Take the `id` or `path` from the footage tool (raw clips) or finished_ads (finished ads) rather than guessing — paths are lowercased and start at /rad/footage.",
    };
  }
  if (clips.length > 1) {
    return {
      error: `${clips.length} clips matched. Two clips can share a path while one is being moved; call again with the \`id\` of the one you mean.`,
      candidates: clips.map(({ id, path, name, kind }) => ({ id, path, name, kind })),
    };
  }

  const [c] = clips;
  const about = {
    id: c.id,
    path: c.path,
    name: c.name,
    kind: c.kind,
    transcriptionStatus: c.transcriptionStatus,
    durationMs: c.durationMs,
    durationSeconds: c.durationMs === null ? null : Math.round(c.durationMs / 100) / 10,
  };

  if (c.transcriptionStatus === "no-audio") {
    return {
      clip: about,
      timed: false,
      segments: [],
      note: "This clip has no speech, so there is nothing to time. That is ordinary for b-roll; choosing cuts in it needs the picture, which nothing here can see.",
    };
  }
  if (c.transcriptionStatus === null) {
    return { clip: about, timed: false, segments: null, note: "This clip has not been transcribed yet. The next footage sync transcribes it." };
  }
  if (c.transcriptionStatus !== "ok") {
    return {
      clip: about,
      timed: false,
      segments: null,
      note: `This clip could not be transcribed${c.transcriptionDetail ? `: ${c.transcriptionDetail}` : "."}`,
    };
  }
  if (!c.words || c.words.length === 0) {
    return {
      clip: about,
      timed: false,
      segments: null,
      note: "This clip was transcribed but its word timings are not stored, so no segment can be timed. The next footage sync recovers them from AssemblyAI.",
    };
  }

  const segments = segmentTranscript(c.words, { withWords: opts.withWords });
  const lastEnd = segments.at(-1)!.endMs;
  return {
    clip: about,
    timed: true,
    wordCount: c.words.length,
    segmentCount: segments.length,
    trailingSilenceMs: c.durationMs === null ? null : Math.max(0, c.durationMs - lastEnd),
    segments,
  };
}
