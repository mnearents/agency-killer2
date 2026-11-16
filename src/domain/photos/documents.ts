/**
 * Photo descriptions in the knowledge base, under category `photos`, so
 * `kb_search` finds a picture by what is in it.
 *
 * One document per described picture (a version group's master), written from
 * what the picture is taken to show — corrections over the model's reading.
 * Pictures marked do-not-use have none: search should not offer them.
 *
 * The documents are recomputed whole and compared, rather than patched on
 * every change: a description, a correction, a new master and a move all
 * change the text, and comparing the text catches each of them the same way.
 * Only a changed document is embedded again.
 */

import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { kbDocuments } from "@/db/schema";
import type { EmbeddingClient } from "@/integrations/openai";
import type { PhotoGroup } from "./photos";

export const PHOTOS_CATEGORY = "photos";

export const photoSourceFile = (dropboxId: string) => `photo:${dropboxId}`;

export interface PhotoDocument {
  sourceFile: string;
  title: string;
  content: string;
  contextPrefix: string;
}

/** The document for a described group, or null when it should have none. */
export function photoDocument(g: PhotoGroup): PhotoDocument | null {
  if (g.master.kind !== "source" || g.doNotUse || !g.description) return null;
  const m = g.master;
  const products = g.products ?? [];
  const lines = [
    `Photo #${m.id}: ${g.description}`,
    `Products: ${products.length === 0 ? "none visible" : products.join(", ")}`,
    ...(g.shotType ? [`Shot: ${g.shotType}`] : []),
    ...(m.people ? [`People: ${m.people.join(", ")}`] : []),
    ...(m.background ? [`Background: ${m.background}`] : []),
    ...(m.visibleText ? [`Text in the photo: ${m.visibleText}`] : []),
    ...(m.subjectPosition ? [`Subject: ${m.subjectPosition}; headline space: ${m.headlineSpace ?? "none"}`] : []),
    ...(m.qualityFlags && m.qualityFlags.length > 0 ? [`Quality: ${m.qualityFlags.join(", ")}`] : []),
    ...(m.suggestedUses && m.suggestedUses.length > 0 ? [`Suits: ${m.suggestedUses.join(", ")}`] : []),
    ...(m.width && m.height ? [`Size: ${m.width}x${m.height} ${m.orientation ?? ""}`.trim()] : []),
    `Used before: ${g.used ? "yes" : "no"}`,
    `File: ${m.path}`,
  ];
  return {
    sourceFile: photoSourceFile(m.dropboxId),
    title: `Photo #${m.id}: ${m.name}`,
    content: lines.join("\n"),
    contextPrefix: `Photo in Dropbox ${m.folder || "/RAD/Footage"} — view it with photo_view id ${m.id}`,
  };
}

export interface DocumentRefresh {
  written: number;
  removed: number;
  /** Photo documents with no embedding after this: present, and unreachable by search by meaning. */
  unembedded: number;
  errors: string[];
}

/**
 * Makes the `photos` documents match `groups`: writes new and changed ones,
 * deletes the rest, and embeds any without an embedding.
 */
export async function refreshPhotoDocuments(db: Db, groups: PhotoGroup[], embeddings?: EmbeddingClient): Promise<DocumentRefresh> {
  const errors: string[] = [];
  const wanted = new Map(groups.map(photoDocument).filter((d): d is PhotoDocument => d !== null).map((d) => [d.sourceFile, d]));
  const existing = await db
    .select({ id: kbDocuments.id, sourceFile: kbDocuments.sourceFile, content: kbDocuments.content, hasEmbedding: sql<boolean>`${kbDocuments.embedding} is not null` })
    .from(kbDocuments)
    .where(eq(kbDocuments.category, PHOTOS_CATEGORY));

  const stale = existing.filter((e) => !e.sourceFile || !wanted.has(e.sourceFile) || wanted.get(e.sourceFile)!.content !== e.content);
  if (stale.length > 0) await db.delete(kbDocuments).where(inArray(kbDocuments.id, stale.map((e) => e.id)));
  const kept = new Set(existing.filter((e) => !stale.includes(e)).map((e) => e.sourceFile));

  let written = 0;
  let unembedded = 0;
  let firstError: string | null = null;
  const embed = async (content: string) => {
    if (!embeddings) return null;
    try {
      return (await embeddings.embed(content)).embedding;
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
      return null;
    }
  };

  for (const doc of wanted.values()) {
    if (kept.has(doc.sourceFile)) continue;
    const embedding = await embed(doc.content);
    if (!embedding) unembedded++;
    await db.insert(kbDocuments).values({
      title: doc.title,
      content: doc.content,
      category: PHOTOS_CATEGORY,
      sourceFile: doc.sourceFile,
      contentHash: createHash("sha256").update(doc.content).digest("hex"),
      chunkIndex: 0,
      totalChunks: 1,
      contextPrefix: doc.contextPrefix,
      documentDate: null,
      embedding,
    });
    written++;
  }

  // Kept documents stored without an embedding (a failed call, or no key then).
  for (const doc of existing.filter((e) => !stale.includes(e) && !e.hasEmbedding)) {
    const embedding = await embed(doc.content);
    if (embedding) await db.update(kbDocuments).set({ embedding }).where(and(eq(kbDocuments.id, doc.id), eq(kbDocuments.category, PHOTOS_CATEGORY)));
    else unembedded++;
  }

  if (unembedded > 0) {
    errors.push(
      `${unembedded} photo document(s) have no embedding${firstError ? `: ${firstError}` : embeddings ? "" : " (no OPENAI_API_KEY)"} — ` +
        "kb_search by meaning cannot reach them until the next run embeds them",
    );
  }
  return { written, removed: stale.length, unembedded, errors };
}
