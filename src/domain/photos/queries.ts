/**
 * Reads and the one write over `photos`, for the MCP tools and the sync.
 *
 * The library is ~600 rows, so it is read whole (thumbnails aside) and
 * grouped and filtered in `photos.ts`, where it can be tested without a
 * database.
 */

import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { photos, shopifyProducts } from "@/db/schema";
import type { PhotoRecord } from "./photos";

export const PHOTO_RECORD_COLUMNS = {
  id: photos.id,
  dropboxId: photos.dropboxId,
  path: photos.path,
  folder: photos.folder,
  name: photos.name,
  contentHash: photos.contentHash,
  sizeBytes: photos.sizeBytes,
  modifiedAt: photos.modifiedAt,
  kind: photos.kind,
  used: photos.used,
  groupKey: photos.groupKey,
  isMaster: photos.isMaster,
  groupUsed: photos.groupUsed,
  width: photos.width,
  height: photos.height,
  megapixels: photos.megapixels,
  orientation: photos.orientation,
  takenAt: photos.takenAt,
  camera: photos.camera,
  inspectStatus: photos.inspectStatus,
  inspectError: photos.inspectError,
  description: photos.description,
  products: photos.products,
  shotType: photos.shotType,
  people: photos.people,
  background: photos.background,
  visibleText: photos.visibleText,
  subjectPosition: photos.subjectPosition,
  headlineSpace: photos.headlineSpace,
  qualityFlags: photos.qualityFlags,
  suggestedUses: photos.suggestedUses,
  visionModel: photos.visionModel,
  describedAt: photos.describedAt,
  describedHash: photos.describedHash,
  visionStatus: photos.visionStatus,
  visionAttempts: photos.visionAttempts,
  visionAttemptHash: photos.visionAttemptHash,
  visionError: photos.visionError,
  correctedDescription: photos.correctedDescription,
  correctedProducts: photos.correctedProducts,
  correctedShotType: photos.correctedShotType,
  doNotUse: photos.doNotUse,
  correctionNote: photos.correctionNote,
  correctedBy: photos.correctedBy,
  correctedAt: photos.correctedAt,
};

export async function loadPhotoRecords(db: Db): Promise<PhotoRecord[]> {
  return db.select(PHOTO_RECORD_COLUMNS).from(photos).orderBy(asc(photos.id));
}

/** Stored thumbnails by photo id; a photo never read has none. */
export async function loadThumbnails(db: Db, ids: number[]): Promise<Map<number, Buffer | null>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: photos.id, thumbnail: photos.thumbnail }).from(photos).where(inArray(photos.id, ids));
  // Some drivers hand bytea back as a plain Uint8Array.
  return new Map(rows.map((r) => [r.id, r.thumbnail ? Buffer.from(r.thumbnail) : null]));
}

/** Titles of the products on sale, which is what a photo's products are named from. */
export async function getProductTitles(db: Db): Promise<string[]> {
  const rows = await db.select({ title: shopifyProducts.title }).from(shopifyProducts).where(eq(shopifyProducts.status, "active"));
  return [...new Set(rows.map((r) => r.title.trim()))].sort((a, b) => a.localeCompare(b));
}

export interface PhotoCorrection {
  description?: string;
  products?: string[];
  shotType?: string;
  doNotUse?: boolean;
  note?: string;
  /** Clear every correction, going back to what the model saw. */
  revert?: boolean;
}

/**
 * Records a correction on every file of a picture, so whichever file is its
 * master later still carries it. Unset fields keep the group's current
 * correction: the latest corrected file's values are carried forward.
 */
export async function saveCorrection(db: Db, input: {
  ids: number[];
  current: Pick<PhotoRecord, "correctedDescription" | "correctedProducts" | "correctedShotType" | "doNotUse" | "correctionNote"> | null;
  correction: PhotoCorrection;
  by: string;
  at: Date;
}): Promise<void> {
  const c = input.correction;
  const values = c.revert
    ? { correctedDescription: null, correctedProducts: null, correctedShotType: null, doNotUse: false, correctionNote: c.note ?? null }
    : {
        correctedDescription: c.description ?? input.current?.correctedDescription ?? null,
        correctedProducts: c.products ?? input.current?.correctedProducts ?? null,
        correctedShotType: c.shotType ?? input.current?.correctedShotType ?? null,
        doNotUse: c.doNotUse ?? input.current?.doNotUse ?? false,
        correctionNote: c.note ?? input.current?.correctionNote ?? null,
      };
  await db
    .update(photos)
    .set({ ...values, correctedBy: input.by, correctedAt: input.at })
    .where(inArray(photos.id, input.ids));
}
