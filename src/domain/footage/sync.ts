/**
 * Syncs `/RAD/Footage` — transcribe, tag, and make findable (#13).
 *
 * Pipeline per file: Dropbox temporary link -> AssemblyAI -> Claude for tags
 * -> a `kb_documents` row so `kb_search` finds the clip by what was said in it.
 *
 * Video is never downloaded here. AssemblyAI is handed the link and fetches it
 * itself, so a 2GB camera file never enters this process.
 *
 * Tagging uses the Anthropic client directly rather than the orchestrator.
 * The orchestrator voice-checks every generation, which is right for marketing
 * copy and wrong for metadata: a tag list is not written in Tara's voice and
 * grading it against brand rules would fail copy that was never meant to be
 * copy.
 *
 * The folder is the truth. Clips are identified by Dropbox file ID, so moving
 * or renaming one updates its row and its document in place — no second
 * transcription — and a clip that leaves the folder is deleted along with its
 * transcript and tags. Deletion is driven by what the listing does not
 * contain, which is only safe because `listFolder` throws rather than return a
 * partial listing.
 *
 * What this does NOT do: look at the video. Tags come from the transcript, so
 * silent b-roll is listed, marked `no-audio`, and untagged. Tagging it needs
 * frame extraction and vision, which is the deferred half of #13.
 */

import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import type { DropboxClient, DropboxFileEntry } from "@/integrations/dropbox";
import type { AssemblyAiClient, TranscriptResult } from "@/integrations/assemblyai";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { EmbeddingClient } from "@/integrations/openai";
import { footage, kbDocuments } from "@/db/schema";
import {
  classifyTranscription,
  type TranscriptionStatus,
} from "@/domain/social/transcription";
import {
  isTranscribableMedia,
  planFootage,
  parseTags,
  footageDocument,
  reconcileFootage,
  relocateFootageDocument,
  footageSourceFile,
  footageTranscript,
  chooseRecoveredTranscript,
  TAGGING_INSTRUCTION,
  type FootageTags,
  type StoredFootage,
  type FootageMatch,
} from "./footage";

export interface SyncFootageDeps {
  dropbox: DropboxClient;
  db: Db;
  rootPath: string;
  transcriber?: AssemblyAiClient;
  anthropic?: AnthropicClient;
  embeddingClient?: EmbeddingClient;
  now?: () => Date;
  /** Start clips that used up their attempts again (`!sync footage retry`). */
  retryExhausted?: boolean;
}

export interface SyncFootageResult {
  /** Files in the folder that are video or audio. */
  mediaFiles: number;
  /** Files skipped because nothing about them changed. */
  unchanged: number;
  /**
   * Clips that failed and used up their attempts, so were not tried this run.
   * Counted apart from `unchanged`, or a run skipping 64 failures reads as
   * "0 failed".
   */
  exhausted: number;
  transcribed: number;
  /** Clips with no speech. Ordinary for b-roll, not a failure. */
  silent: number;
  failed: number;
  tagged: number;
  /** Clips found at a new path or name and updated without re-transcribing. */
  moved: number;
  /** Rows from before file IDs were kept, matched to their file this run. */
  adopted: number;
  /** Clips no longer in the folder, deleted with their transcripts. */
  removed: number;
  /** Clips whose word timings were fetched from AssemblyAI's stored transcript. */
  timingsRecovered: number;
  /** Clips transcribed again because no stored transcript matched them. */
  timingsRetranscribed: number;
  /** Footage documents stored without an embedding and embedded this run. */
  embedded: number;
  /**
   * Footage documents that still have no embedding after this run. Search by
   * meaning cannot reach them; they are tried again on the next run.
   */
  unembedded: number;
  errors: string[];
  /** Null when no transcriber is configured — distinct from finding nothing. */
  configured: boolean;
}

async function tagTranscript(
  anthropic: AnthropicClient,
  transcript: string,
): Promise<FootageTags | null> {
  const result = await anthropic.generate(
    `${TAGGING_INSTRUCTION}\n\nTranscript:\n"""\n${transcript.slice(0, 12000)}\n"""`,
    { maxTokens: 500, temperature: 0 },
  );
  return parseTags(result.text);
}

export async function syncFootage(deps: SyncFootageDeps): Promise<SyncFootageResult> {
  const { dropbox, db, rootPath } = deps;
  const now = deps.now ?? (() => new Date());
  const errors: string[] = [];

  if (!deps.transcriber) {
    return {
      mediaFiles: 0, unchanged: 0, exhausted: 0, transcribed: 0, silent: 0, failed: 0, tagged: 0,
      moved: 0, adopted: 0, removed: 0,
      timingsRecovered: 0, timingsRetranscribed: 0, embedded: 0, unembedded: 0,
      errors: ["ASSEMBLYAI_API_KEY not set — footage cannot be transcribed"],
      configured: false,
    };
  }

  // Throws on any failure, including a failed page. Everything below deletes
  // what this listing lacks, so it must be complete or not happen at all.
  const entries = await dropbox.listFolder(rootPath);
  const media = entries.filter(isTranscribableMedia);

  const stored: StoredFootage[] = (await db
    .select({
      dropboxId: footage.dropboxId,
      path: footage.path,
      rev: footage.rev,
      contentHash: footage.contentHash,
      transcriptionStatus: footage.transcriptionStatus,
      transcriptionAttempts: footage.transcriptionAttempts,
      transcriptionDetail: footage.transcriptionDetail,
      hasWords: sql<boolean>`${footage.words} is not null`,
    })
    .from(footage)).map((row) => ({
      ...row,
      transcriptionStatus: row.transcriptionStatus as TranscriptionStatus | null,
    }));

  const { matches, remove } = reconcileFootage(media, stored);

  for (const row of remove) {
    await db.delete(footage).where(
      row.dropboxId === null
        ? and(eq(footage.path, row.path), isNull(footage.dropboxId))
        : eq(footage.dropboxId, row.dropboxId),
    );
  }

  let adopted = 0;
  for (const { entry, known, adopted: isAdopted } of matches) {
    if (!known || !isAdopted) continue;
    await db
      .update(footage)
      .set({ dropboxId: entry.id, contentHash: entry.contentHash, updatedAt: now() })
      .where(and(eq(footage.path, known.path), isNull(footage.dropboxId)));
    await db
      .update(kbDocuments)
      .set({ sourceFile: footageSourceFile(entry.id) })
      .where(eq(kbDocuments.sourceFile, `footage:${known.path}`));
    adopted++;
  }

  // Every footage document must belong to a clip in the folder. This removes
  // the transcripts of the clips deleted above, and any left by earlier runs.
  await db.delete(kbDocuments).where(and(
    eq(kbDocuments.category, "footage"),
    notInArray(kbDocuments.sourceFile, media.map((m) => footageSourceFile(m.id))),
  ));

  const timings = await recoverTimings(deps, matches, errors);
  let timingsRetranscribed = 0;

  let unchanged = 0, exhausted = 0, transcribed = 0, silent = 0, failed = 0, tagged = 0, moved = 0;

  for (const { entry, known: prior, moved: isMoved } of matches) {
    const key = entry.path.toLowerCase();
    let plan = planFootage(entry, prior, { retryExhausted: deps.retryExhausted });

    if (plan.action === "skip" && isMoved) {
      const relocated = await relocateFootage(deps, entry, key, now, errors);
      if (relocated) {
        moved++;
        continue;
      }
      // A document this module cannot rewrite is transcribed afresh rather
      // than left pointing at a path that no longer exists.
      plan = { action: "transcribe", reason: "retry" };
    }

    // Transcribed before words were kept, and AssemblyAI holds no transcript
    // that can be matched to it with confidence. Transcribing again is the
    // only way to a cut list for it.
    if (plan.action === "skip" && timings.retranscribe.has(entry.id)) {
      plan = { action: "transcribe", reason: "timings" };
      timingsRetranscribed++;
    }

    if (plan.action === "skip") {
      if (plan.reason === "attempts-exhausted") exhausted++;
      else unchanged++;
      continue;
    }

    // A replaced file is a different video, so its previous attempts no longer
    // describe it and the count starts again. So does a deliberate retry.
    const attemptsBefore = plan.reason === "replaced" || plan.reason === "reset"
      ? 0
      : (prior?.transcriptionAttempts ?? 0);

    const { raw, classified } = await (async () => {
      try {
        const link = await dropbox.getTemporaryLink(entry.path);
        const result = await deps.transcriber!.transcribe(link);
        return { raw: result, classified: classifyTranscription(result) };
      } catch (err) {
        return { raw: null, classified: classifyTranscription(null, err) };
      }
    })();
    const timing = {
      transcriptId: raw?.id ?? null,
      // Empty for a clip with no speech: there are no words, and that is known.
      words: classified.status === "ok"
        ? raw?.words ?? null
        : classified.status === "no-audio" ? [] : null,
      durationMs: raw?.durationMs ?? null,
    };

    let tags: FootageTags | null = null;
    if (classified.status === "ok" && classified.text && deps.anthropic) {
      try {
        tags = await tagTranscript(deps.anthropic, classified.text);
        if (tags) tagged++;
      } catch (err) {
        errors.push(`Tagging failed for ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await db
      .insert(footage)
      .values({
        dropboxId: entry.id,
        path: key,
        name: entry.name,
        rev: entry.rev,
        contentHash: entry.contentHash,
        sizeBytes: entry.size,
        transcriptionStatus: classified.status,
        transcriptionAttempts: attemptsBefore + 1,
        transcriptionAttemptedAt: now(),
        transcriptionDetail: classified.detail,
        ...timing,
        tags: tags?.tags ?? null,
        summary: tags?.summary ?? null,
        taggedAt: tags ? now() : null,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: footage.dropboxId,
        set: {
          path: key,
          name: entry.name,
          rev: entry.rev,
          contentHash: entry.contentHash,
          sizeBytes: entry.size,
          transcriptionStatus: classified.status,
          transcriptionAttempts: attemptsBefore + 1,
          transcriptionAttemptedAt: now(),
          transcriptionDetail: classified.detail,
          ...timing,
          tags: tags?.tags ?? null,
          summary: tags?.summary ?? null,
          taggedAt: tags ? now() : null,
          updatedAt: now(),
        },
      });

    if (classified.status === "no-audio") { silent++; continue; }
    if (classified.status !== "ok" || !classified.text) {
      failed++;
      if (classified.detail) errors.push(`${entry.name}: ${classified.detail}`);
      continue;
    }

    // Only a real transcript becomes knowledge. A silent clip is recorded in
    // `footage` and deliberately left out of the knowledge base, so a search
    // never returns a document that says nothing.
    const doc = footageDocument({
      name: entry.name,
      path: entry.path,
      summary: tags?.summary ?? null,
      tags: tags?.tags ?? null,
      transcript: classified.text,
    });

    let embedding: number[] | null = null;
    if (deps.embeddingClient) {
      try {
        embedding = (await deps.embeddingClient.embed(doc.content)).embedding;
      } catch (err) {
        errors.push(`Embedding failed for ${entry.name} — stored without one, tried again at the end of this run and the next: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Replacing a file replaces its document, or the old transcript stays
    // searchable and points at a video that no longer says that.
    await db.delete(kbDocuments).where(eq(kbDocuments.sourceFile, footageSourceFile(entry.id)));
    await db.insert(kbDocuments).values({
      title: doc.title,
      content: doc.content,
      category: "footage",
      sourceFile: footageSourceFile(entry.id),
      contentHash: entry.rev,
      chunkIndex: 0,
      totalChunks: 1,
      contextPrefix: doc.contextPrefix,
      documentDate: null,
      embedding,
    });
    transcribed++;
  }

  const { embedded, unembedded } = await embedMissing(deps, errors);

  return {
    mediaFiles: media.length,
    unchanged, exhausted, transcribed, silent, failed, tagged,
    moved, adopted, removed: remove.length,
    timingsRecovered: timings.recovered, timingsRetranscribed,
    embedded, unembedded,
    errors,
    configured: true,
  };
}

/**
 * Points a moved clip's row and document at its new path.
 *
 * Returns false only when the clip has a document this module cannot rewrite.
 * A clip with no document at all — silent b-roll — moves by its row alone.
 */
async function relocateFootage(
  deps: SyncFootageDeps,
  entry: DropboxFileEntry,
  key: string,
  now: () => Date,
  errors: string[],
): Promise<boolean> {
  const { db } = deps;
  const sourceFile = footageSourceFile(entry.id);
  const [doc] = await db
    .select({ content: kbDocuments.content })
    .from(kbDocuments)
    .where(eq(kbDocuments.sourceFile, sourceFile));

  if (doc) {
    const relocated = relocateFootageDocument(doc.content, { name: entry.name, path: key });
    if (!relocated) return false;

    // The path and name are in the embedded text, so the old vector describes
    // the old name. If re-embedding fails the old one is kept — still the same
    // transcript, and far better than a document search cannot reach.
    let embedding: number[] | undefined;
    if (deps.embeddingClient) {
      try {
        embedding = (await deps.embeddingClient.embed(relocated.content)).embedding;
      } catch (err) {
        errors.push(`Re-embedding failed for moved ${entry.name} — kept its previous embedding: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await db
      .update(kbDocuments)
      .set({ ...relocated, ...(embedding ? { embedding } : {}) })
      .where(eq(kbDocuments.sourceFile, sourceFile));
  }

  await db
    .update(footage)
    .set({ path: key, name: entry.name, rev: entry.rev, updatedAt: now() })
    .where(eq(footage.dropboxId, entry.id));
  return true;
}

/** Transcripts read from AssemblyAI at once while recovering word timings. */
const RECOVERY_CONCURRENCY = 8;

/**
 * Fetches word timings for clips transcribed before they were kept.
 *
 * Nothing recorded which AssemblyAI transcript a clip came from, but the
 * stored transcript is exactly AssemblyAI's text, and AssemblyAI keeps every
 * transcript. So each one is read and matched to clips by text. A clip with no
 * confident match is returned in `retranscribe`.
 *
 * Only a complete read may send anything to be transcribed again: a transcript
 * that could not be read is a match that may have been missed, and the clips
 * it would have matched are left for the next run rather than paid for twice.
 * Runs only while some transcribed clip has no words, so it stops once all do.
 */
async function recoverTimings(
  deps: SyncFootageDeps,
  matches: FootageMatch[],
  errors: string[],
): Promise<{ recovered: number; retranscribe: Set<string> }> {
  const none = { recovered: 0, retranscribe: new Set<string>() };
  const missing = matches.filter((m) => m.known?.transcriptionStatus === "ok" && !m.known.hasWords);
  if (missing.length === 0) return none;

  const docs = await deps.db
    .select({ sourceFile: kbDocuments.sourceFile, content: kbDocuments.content })
    .from(kbDocuments)
    .where(eq(kbDocuments.category, "footage"));
  const contentBySource = new Map(docs.map((d) => [d.sourceFile, d.content]));

  const clipsByText = new Map<string, string[]>();
  const unreadable: string[] = [];
  for (const { entry } of missing) {
    const content = contentBySource.get(footageSourceFile(entry.id));
    const transcript = content ? footageTranscript(content)?.trim() : null;
    if (!transcript) { unreadable.push(entry.id); continue; }
    clipsByText.set(transcript, [...(clipsByText.get(transcript) ?? []), entry.id]);
  }

  let ids: string[];
  try {
    ids = await deps.transcriber!.listCompletedTranscriptIds();
  } catch (err) {
    errors.push(`Word timings not recovered for ${missing.length} clip(s), and none transcribed again: ${err instanceof Error ? err.message : String(err)}`);
    return none;
  }

  // Indexed by position in the listing, so candidates keep its newest-first order.
  const candidates = new Map<string, { at: number; transcript: TranscriptResult }[]>();
  let unread = 0;
  let firstReadError: string | null = null;
  for (let i = 0; i < ids.length; i += RECOVERY_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + RECOVERY_CONCURRENCY).map(async (id, j) => {
      try {
        const transcript = await deps.transcriber!.getTranscript(id);
        const text = transcript.text?.trim();
        if (!text || !clipsByText.has(text)) return;
        candidates.set(text, [...(candidates.get(text) ?? []), { at: i + j, transcript }]);
      } catch (err) {
        unread++;
        firstReadError ??= err instanceof Error ? err.message : String(err);
      }
    }));
  }

  let recovered = 0;
  const unmatched = [...unreadable];
  for (const [text, clipIds] of clipsByText) {
    const chosen = chooseRecoveredTranscript(
      (candidates.get(text) ?? []).sort((a, b) => a.at - b.at).map((c) => c.transcript),
    );
    if (!chosen) { unmatched.push(...clipIds); continue; }
    await deps.db
      .update(footage)
      .set({ transcriptId: chosen.id, words: chosen.words ?? [], durationMs: chosen.durationMs ?? null })
      .where(inArray(footage.dropboxId, clipIds));
    recovered += clipIds.length;
  }

  if (unread > 0) {
    errors.push(
      `${unread} AssemblyAI transcript(s) could not be read (${firstReadError}) — ` +
        `${unmatched.length} clip(s) left without word timings until the next run rather than transcribed again`,
    );
    return { recovered, retranscribe: new Set() };
  }
  return { recovered, retranscribe: new Set(unmatched) };
}

/**
 * Embeds footage documents that were stored without an embedding — because
 * the embedding call failed, or no key was set when they were written.
 *
 * Search by meaning cannot reach a document with no embedding, so one that
 * fails is not given up on: it is counted and tried again next run.
 */
async function embedMissing(
  deps: SyncFootageDeps,
  errors: string[],
): Promise<{ embedded: number; unembedded: number }> {
  const rows = await deps.db
    .select({ id: kbDocuments.id, content: kbDocuments.content })
    .from(kbDocuments)
    .where(and(eq(kbDocuments.category, "footage"), isNull(kbDocuments.embedding)));
  if (rows.length === 0) return { embedded: 0, unembedded: 0 };
  if (!deps.embeddingClient) return { embedded: 0, unembedded: rows.length };

  let embedded = 0;
  let firstError: string | null = null;
  for (const row of rows) {
    try {
      const { embedding } = await deps.embeddingClient.embed(row.content);
      await deps.db.update(kbDocuments).set({ embedding }).where(eq(kbDocuments.id, row.id));
      embedded++;
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
    }
  }
  const unembedded = rows.length - embedded;
  if (unembedded > 0) {
    errors.push(
      `${unembedded} footage document(s) still have no embedding: ${firstError} — ` +
        "unsearchable by meaning until then; tried again next run",
    );
  }
  return { embedded, unembedded };
}
