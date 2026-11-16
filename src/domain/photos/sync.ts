/**
 * Indexes the photos in Dropbox /RAD/Footage — part of the daily footage
 * sync — and describes them with a vision model.
 *
 * Read-only in Dropbox: it lists and downloads, nothing else.
 *
 * Per run:
 *  1. List the folder (complete or not at all: rows missing from it are
 *     deleted). Photos are .jpg, .jpeg, .png and .webp.
 *  2. Download and read only new or changed files (by Dropbox content hash):
 *     dimensions, EXIF date and camera, and a small thumbnail kept for
 *     contact sheets. A move or rename updates the row without a download.
 *  3. Recompute version groups and their masters.
 *  4. Describe each group master of kind `source` that has no description of
 *     its current bytes — copying one from a file of the same picture when
 *     there is one, so a copy or a bigger version costs nothing. Only when
 *     describing is on: it is paid, so it is switched on deliberately.
 *  5. Make the `photos` knowledge-base documents match.
 *
 * Corrections made with photo_tag_set are never written here, beyond giving
 * a file that joins a corrected picture the same correction.
 */

import { eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { photos } from "@/db/schema";
import type { DropboxClient, DropboxFileEntry } from "@/integrations/dropbox";
import type { AnthropicClient } from "@/integrations/anthropic";
import type { EmbeddingClient } from "@/integrations/openai";
import { inspectImage, resizeToJpeg } from "@/integrations/images";
import {
  isPhotoFile,
  folderOf,
  photoKind,
  isUsedFolder,
  orientationOf,
  megapixelsOf,
  groupPhotos,
  planInspect,
  buildLibrary,
  MAX_VISION_ATTEMPTS,
  type PhotoKind,
  type PhotoRecord,
} from "./photos";
import {
  buildPhotoPrompt,
  parsePhotoDescription,
  visionCost,
  PHOTO_VISION_MODEL,
  VISION_MAX_DIMENSION,
  VISION_MAX_TOKENS,
} from "./vision";
import { loadPhotoRecords, getProductTitles } from "./queries";
import { refreshPhotoDocuments } from "./documents";

/** The longest side of the thumbnail stored for contact sheets. */
export const THUMBNAIL_DIMENSION = 384;

export interface SyncPhotosDeps {
  dropbox: DropboxClient;
  db: Db;
  rootPath: string;
  anthropic?: AnthropicClient;
  embeddingClient?: EmbeddingClient;
  now?: () => Date;
  /**
   * Whether to call the vision model, and for at most how many pictures.
   * Off, nothing is described and the result says how many are waiting.
   */
  describe: { enabled: boolean; limit?: number };
}

export interface SyncPhotosResult {
  /** Image files in the folder, by kind. */
  files: number;
  filesByKind: Record<PhotoKind, number>;
  /** Pictures: version groups. */
  groups: number;
  /** Downloaded and read this run. */
  inspected: number;
  inspectFailed: number;
  /** Unreadable three times, so not tried this run. */
  inspectExhausted: number;
  unchanged: number;
  moved: number;
  removed: number;
  described: number;
  /** Descriptions copied from another file of the same picture, at no cost. */
  descriptionsCopied: number;
  describeFailed: number;
  /** Source pictures still without a description after this run. */
  awaitingDescription: number;
  /** Why pictures were left waiting, when any were. */
  describeHeldBack: "off" | "no-anthropic" | "limit" | null;
  visionInputTokens: number;
  visionOutputTokens: number;
  /** Dollars this run spent on descriptions. */
  visionCost: number;
  documents: { written: number; removed: number; unembedded: number };
  errors: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function locationOf(entry: DropboxFileEntry, rootPath: string) {
  const folder = folderOf(entry.displayPath, rootPath);
  return {
    path: entry.displayPath,
    folder,
    name: entry.name,
    kind: photoKind(folder, entry.name),
    used: isUsedFolder(folder),
    sizeBytes: entry.size,
    modifiedAt: entry.modified ? new Date(entry.modified) : null,
  };
}

export async function syncPhotos(deps: SyncPhotosDeps): Promise<SyncPhotosResult> {
  const { dropbox, db, rootPath } = deps;
  const now = deps.now ?? (() => new Date());
  const errors: string[] = [];

  // Throws on a failed page: rows missing from the listing are deleted below.
  const files = (await dropbox.listFolder(rootPath)).filter(isPhotoFile).filter((e) => e.contentHash);

  const stored = await db
    .select({
      dropboxId: photos.dropboxId,
      path: photos.path,
      contentHash: photos.contentHash,
      inspectedHash: photos.inspectedHash,
      inspectStatus: photos.inspectStatus,
      inspectAttempts: photos.inspectAttempts,
    })
    .from(photos);
  const storedById = new Map(stored.map((s) => [s.dropboxId, s]));

  const listedIds = files.map((f) => f.id);
  const gone = stored.filter((s) => !listedIds.includes(s.dropboxId));
  if (gone.length > 0) {
    await db.delete(photos).where(listedIds.length > 0 ? notInArray(photos.dropboxId, listedIds) : undefined);
  }

  let inspected = 0, inspectFailed = 0, inspectExhausted = 0, unchanged = 0, moved = 0;
  for (const entry of files) {
    const prior = storedById.get(entry.id);
    const plan = planInspect(entry, prior);
    const location = locationOf(entry, rootPath);

    if (plan.action === "skip") {
      if (plan.reason === "attempts-exhausted") inspectExhausted++;
      else unchanged++;
      if (plan.moved) {
        await db.update(photos).set({ ...location, updatedAt: now() }).where(eq(photos.dropboxId, entry.id));
        moved++;
      }
      continue;
    }

    let read: Partial<typeof photos.$inferInsert>;
    try {
      const data = await dropbox.downloadFile(entry.path);
      const facts = await inspectImage(data);
      const thumb = await resizeToJpeg(data, THUMBNAIL_DIMENSION, 78);
      read = {
        width: facts.width,
        height: facts.height,
        megapixels: megapixelsOf(facts.width, facts.height),
        orientation: orientationOf(facts.width, facts.height),
        takenAt: facts.takenAt,
        camera: facts.camera,
        thumbnail: thumb.data,
        inspectStatus: "ok",
        inspectError: null,
      };
      inspected++;
    } catch (err) {
      read = { inspectStatus: "error", inspectError: message(err).slice(0, 500) };
      inspectFailed++;
      errors.push(`${entry.displayPath}: could not be read — ${message(err)}`);
    }

    const values = {
      ...location,
      ...read,
      contentHash: entry.contentHash!,
      inspectedHash: entry.contentHash!,
      inspectAttempts: plan.attemptsBefore + 1,
      updatedAt: now(),
    };
    await db
      .insert(photos)
      // A first sighting needs a group; step 3 sets the real one.
      .values({ dropboxId: entry.id, groupKey: entry.id, ...values })
      .onConflictDoUpdate({ target: photos.dropboxId, set: values });
  }

  // ─── Version groups ───
  let records = await loadPhotoRecords(db);
  const grouping = groupPhotos(records);
  for (const r of records) {
    const g = grouping.get(r.id)!;
    if (g.groupKey !== r.groupKey || g.isMaster !== r.isMaster || g.groupUsed !== r.groupUsed) {
      await db.update(photos).set({ groupKey: g.groupKey, isMaster: g.isMaster, groupUsed: g.groupUsed }).where(eq(photos.id, r.id));
    }
  }
  records = await loadPhotoRecords(db);
  await carryCorrections(db, records);
  records = await loadPhotoRecords(db);

  // ─── Descriptions ───
  const vision = await describeMasters(deps, records, now, errors);
  records = await loadPhotoRecords(db);
  const library = buildLibrary(records);

  // ─── Knowledge base ───
  let documents = { written: 0, removed: 0, unembedded: 0 };
  try {
    const refresh = await refreshPhotoDocuments(db, library, deps.embeddingClient);
    documents = { written: refresh.written, removed: refresh.removed, unembedded: refresh.unembedded };
    errors.push(...refresh.errors);
  } catch (err) {
    errors.push(`Photo documents not updated for kb_search: ${message(err)}`);
  }

  const awaiting = library.filter((g) => g.master.kind === "source" && g.state === "awaiting").length;
  return {
    files: files.length,
    filesByKind: {
      source: records.filter((r) => r.kind === "source").length,
      screenshot: records.filter((r) => r.kind === "screenshot").length,
      "old-graphic": records.filter((r) => r.kind === "old-graphic").length,
    },
    groups: library.length,
    inspected, inspectFailed, inspectExhausted, unchanged, moved,
    removed: gone.length,
    described: vision.described,
    descriptionsCopied: vision.copied,
    describeFailed: vision.failed,
    awaitingDescription: awaiting,
    describeHeldBack: awaiting === 0 ? null : vision.heldBack,
    visionInputTokens: vision.inputTokens,
    visionOutputTokens: vision.outputTokens,
    visionCost: visionCost(vision.inputTokens, vision.outputTokens),
    documents,
    errors,
  };
}

/**
 * A file that joined a corrected picture takes the picture's correction, so
 * the correction holds whichever file is master.
 */
async function carryCorrections(db: Db, records: PhotoRecord[]): Promise<void> {
  const byGroup = new Map<string, PhotoRecord[]>();
  for (const r of records) byGroup.set(r.groupKey, [...(byGroup.get(r.groupKey) ?? []), r]);
  for (const members of byGroup.values()) {
    const latest = members
      .filter((m) => m.correctedAt !== null)
      .sort((a, b) => b.correctedAt!.getTime() - a.correctedAt!.getTime())[0];
    if (!latest) continue;
    const behind = members.filter((m) => m.correctedAt === null || m.correctedAt.getTime() !== latest.correctedAt!.getTime());
    if (behind.length === 0) continue;
    await db
      .update(photos)
      .set({
        correctedDescription: latest.correctedDescription,
        correctedProducts: latest.correctedProducts,
        correctedShotType: latest.correctedShotType,
        doNotUse: latest.doNotUse,
        correctionNote: latest.correctionNote,
        correctedBy: latest.correctedBy,
        correctedAt: latest.correctedAt,
      })
      .where(inArray(photos.id, behind.map((m) => m.id)));
  }
}

const describedNow = (r: PhotoRecord) => r.visionStatus === "ok" && r.describedHash === r.contentHash;
/** Attempts to describe these bytes; a replaced file starts again at zero. */
const attemptsOn = (r: PhotoRecord) => (r.visionAttemptHash === r.contentHash ? r.visionAttempts : 0);

async function describeMasters(
  deps: SyncPhotosDeps,
  records: PhotoRecord[],
  now: () => Date,
  errors: string[],
): Promise<{ described: number; copied: number; failed: number; inputTokens: number; outputTokens: number; heldBack: "off" | "no-anthropic" | "limit" }> {
  const { db } = deps;
  const out = { described: 0, copied: 0, failed: 0, inputTokens: 0, outputTokens: 0, heldBack: "off" as "off" | "no-anthropic" | "limit" };
  const pending = records.filter((r) => r.isMaster && r.kind === "source" && r.inspectStatus === "ok" && !describedNow(r));
  if (pending.length === 0) return out;

  // A description of the same picture: identical bytes anywhere, or any file in the group.
  const donors = records.filter(describedNow);
  const copyable = pending.filter((r) => donors.some((d) => d.id !== r.id && (d.contentHash === r.contentHash || d.groupKey === r.groupKey)));
  for (const r of copyable) {
    const d = donors.find((x) => x.id !== r.id && x.contentHash === r.contentHash) ?? donors.find((x) => x.id !== r.id && x.groupKey === r.groupKey)!;
    await db.update(photos).set({
      description: d.description,
      products: d.products,
      shotType: d.shotType,
      people: d.people,
      background: d.background,
      visibleText: d.visibleText,
      subjectPosition: d.subjectPosition,
      headlineSpace: d.headlineSpace,
      qualityFlags: d.qualityFlags,
      suggestedUses: d.suggestedUses,
      visionModel: d.visionModel,
      describedAt: d.describedAt,
      describedHash: r.contentHash,
      describedFrom: d.id,
      visionInputTokens: null,
      visionOutputTokens: null,
      visionStatus: "ok",
      visionError: null,
    }).where(eq(photos.id, r.id));
    out.copied++;
  }

  const toLook = pending
    .filter((r) => !copyable.includes(r))
    // Three failures on these bytes and it waits for a new file, not a new day.
    .filter((r) => attemptsOn(r) < MAX_VISION_ATTEMPTS);
  if (toLook.length === 0) return out;
  if (!deps.describe.enabled) return { ...out, heldBack: "off" };
  if (!deps.anthropic) return { ...out, heldBack: "no-anthropic" };

  const titles = await getProductTitles(db);
  const limit = deps.describe.limit ?? Infinity;

  for (const r of toLook) {
    if (out.described + out.failed >= limit) {
      out.heldBack = "limit";
      break;
    }
    const attemptsBefore = attemptsOn(r);
    try {
      const data = await deps.dropbox.downloadFile(r.path);
      const copy = await resizeToJpeg(data, VISION_MAX_DIMENSION, 85);
      const result = await deps.anthropic.generate(buildPhotoPrompt({ folder: r.folder, name: r.name, productTitles: titles }), {
        model: PHOTO_VISION_MODEL,
        maxTokens: VISION_MAX_TOKENS,
        images: [{ mediaType: "image/jpeg", data: copy.data }],
      });
      out.inputTokens += result.inputTokens;
      out.outputTokens += result.outputTokens;
      const parsed = parsePhotoDescription(result.text, titles);
      if (!parsed) throw new Error(`the description could not be read: ${result.text.slice(0, 200)}`);
      await db.update(photos).set({
        ...parsed,
        visionModel: PHOTO_VISION_MODEL,
        describedAt: now(),
        describedHash: r.contentHash,
        describedFrom: null,
        visionInputTokens: result.inputTokens,
        visionOutputTokens: result.outputTokens,
        visionStatus: "ok",
        visionAttempts: attemptsBefore + 1,
        visionAttemptHash: r.contentHash,
        visionError: null,
      }).where(eq(photos.id, r.id));
      out.described++;
    } catch (err) {
      await db.update(photos).set({
        visionStatus: "error",
        visionAttempts: attemptsBefore + 1,
        visionAttemptHash: r.contentHash,
        visionError: message(err).slice(0, 500),
      }).where(eq(photos.id, r.id));
      out.failed++;
      errors.push(`${r.path}: not described — ${message(err)}`);
    }
  }
  return out;
}
