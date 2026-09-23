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
 * What this does NOT do: look at the video. Tags come from the transcript, so
 * silent b-roll is listed, marked `no-audio`, and untagged. Tagging it needs
 * frame extraction and vision, which is the deferred half of #13.
 */

import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import type { DropboxClient } from "@/integrations/dropbox";
import type { AssemblyAiClient } from "@/integrations/assemblyai";
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
  TAGGING_INSTRUCTION,
  type FootageTags,
} from "./footage";

export interface SyncFootageDeps {
  dropbox: DropboxClient;
  db: Db;
  rootPath: string;
  transcriber?: AssemblyAiClient;
  anthropic?: AnthropicClient;
  embeddingClient?: EmbeddingClient;
  now?: () => Date;
}

export interface SyncFootageResult {
  /** Files in the folder that are video or audio. */
  mediaFiles: number;
  /** Files skipped because nothing about them changed. */
  unchanged: number;
  transcribed: number;
  /** Clips with no speech. Ordinary for b-roll, not a failure. */
  silent: number;
  failed: number;
  tagged: number;
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
      mediaFiles: 0, unchanged: 0, transcribed: 0, silent: 0, failed: 0, tagged: 0,
      errors: ["ASSEMBLYAI_API_KEY not set — footage cannot be transcribed"],
      configured: false,
    };
  }

  const entries = await dropbox.listFolder(rootPath);
  const media = entries.filter(isTranscribableMedia);

  const known = media.length === 0 ? [] : await db
    .select({
      path: footage.path,
      rev: footage.rev,
      transcriptionStatus: footage.transcriptionStatus,
      transcriptionAttempts: footage.transcriptionAttempts,
    })
    .from(footage)
    .where(inArray(footage.path, media.map((m) => m.path.toLowerCase())));

  const byPath = new Map(known.map((k) => [k.path, k]));

  let unchanged = 0, transcribed = 0, silent = 0, failed = 0, tagged = 0;

  for (const entry of media) {
    const key = entry.path.toLowerCase();
    const prior = byPath.get(key);
    const plan = planFootage(entry, prior === undefined ? undefined : {
      rev: prior.rev,
      transcriptionStatus: prior.transcriptionStatus as TranscriptionStatus | null,
      transcriptionAttempts: prior.transcriptionAttempts,
    });

    if (plan.action === "skip") {
      unchanged++;
      continue;
    }

    // A replaced file is a different video, so its previous attempts no longer
    // describe it and the count starts again.
    const attemptsBefore = plan.reason === "replaced" ? 0 : (prior?.transcriptionAttempts ?? 0);

    const classified = await (async () => {
      try {
        const link = await dropbox.getTemporaryLink(entry.path);
        return classifyTranscription(await deps.transcriber!.transcribe(link));
      } catch (err) {
        return classifyTranscription(null, err);
      }
    })();

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
        path: key,
        name: entry.name,
        rev: entry.rev,
        sizeBytes: entry.size,
        transcriptionStatus: classified.status,
        transcriptionAttempts: attemptsBefore + 1,
        transcriptionAttemptedAt: now(),
        transcriptionDetail: classified.detail,
        tags: tags?.tags ?? null,
        summary: tags?.summary ?? null,
        taggedAt: tags ? now() : null,
        updatedAt: now(),
      })
      .onConflictDoUpdate({
        target: footage.path,
        set: {
          name: entry.name,
          rev: entry.rev,
          sizeBytes: entry.size,
          transcriptionStatus: classified.status,
          transcriptionAttempts: attemptsBefore + 1,
          transcriptionAttemptedAt: now(),
          transcriptionDetail: classified.detail,
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
        errors.push(`Embedding failed for ${entry.name} — stored unsearchable: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Replacing a file replaces its document, or the old transcript stays
    // searchable and points at a video that no longer says that.
    await db.delete(kbDocuments).where(eq(kbDocuments.sourceFile, `footage:${key}`));
    await db.insert(kbDocuments).values({
      title: doc.title,
      content: doc.content,
      category: "footage",
      sourceFile: `footage:${key}`,
      contentHash: entry.rev,
      chunkIndex: 0,
      totalChunks: 1,
      contextPrefix: doc.contextPrefix,
      documentDate: null,
      embedding,
    });
    transcribed++;
  }

  return {
    mediaFiles: media.length,
    unchanged, transcribed, silent, failed, tagged,
    errors,
    configured: true,
  };
}
