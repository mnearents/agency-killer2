/**
 * Photos in Dropbox /RAD/Footage: what each file is, which files are the same
 * picture, and which of those to show.
 *
 * Pure — no network, no database, no clock.
 *
 * The same picture is often kept at several sizes: "X Large.jpeg" beside
 * "too big/X.jpg", with the one actually sent filed under "used". Those are
 * one version group, and the largest file is its master. Files with identical
 * bytes are one group too: "photo (1).jpg" and "photo (2).jpg" are the same
 * picture under two names, and describing it twice buys nothing.
 */

import type { DropboxFileEntry } from "@/integrations/dropbox";

export const PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const;

export const PHOTO_KINDS = ["source", "screenshot", "old-graphic"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** Folders whose contents are finished graphics, not photos to use. */
export const OLD_GRAPHIC_FOLDERS = ["old ad stuff to organize", "finished ads"];

/** Subfolders that hold another size of their parent's pictures. */
const VERSION_FOLDERS = ["too big", "used"];

export const ORIENTATIONS = ["portrait", "landscape", "square"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

const extensionOf = (name: string) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");

export function isPhotoFile(entry: Pick<DropboxFileEntry, "name" | "isFolder">): boolean {
  if (entry.isFolder || entry.name === ".DS_Store") return false;
  return (PHOTO_EXTENSIONS as readonly string[]).includes(extensionOf(entry.name));
}

/**
 * The folder a file is in, relative to the footage root, capitals kept:
 * "Planners/2027 planner pictures/8x10 dated". Empty at the root itself.
 */
export function folderOf(displayPath: string, rootPath: string): string {
  const root = rootPath.replace(/\/+$/, "");
  const inside = displayPath.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? displayPath.slice(root.length + 1) : displayPath.replace(/^\/+/, "");
  const cut = inside.lastIndexOf("/");
  return cut === -1 ? "" : inside.slice(0, cut);
}

const segments = (folder: string) => folder.split("/").filter(Boolean).map((s) => s.toLowerCase());

export function photoKind(folder: string, name: string): PhotoKind {
  if (segments(folder).some((s) => OLD_GRAPHIC_FOLDERS.includes(s))) return "old-graphic";
  if (name.toLowerCase().startsWith("screenshot")) return "screenshot";
  return "source";
}

export function isUsedFolder(folder: string): boolean {
  return segments(folder).includes("used");
}

/**
 * The name the versions of one picture share: the parent folder, without a
 * trailing "too big" or "used", and the file name without its extension or a
 * trailing " Large". Lowercased.
 */
export function versionKey(folder: string, name: string): string {
  const dir = segments(folder);
  while (dir.length > 0 && VERSION_FOLDERS.includes(dir[dir.length - 1])) dir.pop();
  const ext = extensionOf(name);
  const base = (ext ? name.slice(0, -(ext.length + 1)) : name).replace(/ large$/i, "").trim().toLowerCase();
  return `${dir.join("/")}/${base}`;
}

export function orientationOf(width: number, height: number): Orientation {
  if (Math.abs(width - height) <= 0.02 * Math.max(width, height)) return "square";
  return width > height ? "landscape" : "portrait";
}

export const megapixelsOf = (width: number, height: number) => Math.round((width * height) / 100_000) / 10;

// ─── Version groups ───────────────────────────────────────────────────

export interface GroupMember {
  id: number;
  folder: string;
  name: string;
  path: string;
  contentHash: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  used: boolean;
}

export interface Grouping {
  groupKey: string;
  isMaster: boolean;
  groupUsed: boolean;
}

/** Largest picture first; then the larger file; then by path, so the choice is stable. */
function masterOrder(a: GroupMember, b: GroupMember): number {
  const pixels = (m: GroupMember) => (m.width ?? 0) * (m.height ?? 0);
  return pixels(b) - pixels(a) || b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path);
}

/**
 * Each file's group, whether it is the master, and whether the group was used.
 * Files join a group by version name or by identical bytes, transitively.
 */
export function groupPhotos(members: GroupMember[]): Map<number, Grouping> {
  const parent = new Map<number, number>(members.map((m) => [m.id, m.id]));
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };

  const firstBy = new Map<string, number>();
  for (const m of members) {
    for (const k of [`key:${versionKey(m.folder, m.name)}`, `hash:${m.contentHash}`]) {
      const seen = firstBy.get(k);
      if (seen === undefined) firstBy.set(k, m.id);
      else union(seen, m.id);
    }
  }

  const groups = new Map<number, GroupMember[]>();
  for (const m of members) groups.set(find(m.id), [...(groups.get(find(m.id)) ?? []), m]);

  const result = new Map<number, Grouping>();
  for (const group of groups.values()) {
    const ordered = [...group].sort(masterOrder);
    // The smallest version name: the same whichever file is master, so a
    // bigger copy arriving does not rename the group.
    const groupKey = group.map((m) => versionKey(m.folder, m.name)).sort()[0];
    const groupUsed = group.some((m) => m.used);
    ordered.forEach((m, i) => result.set(m.id, { groupKey, isMaster: i === 0, groupUsed }));
  }
  return result;
}

// ─── Planning a sync ──────────────────────────────────────────────────

export const MAX_INSPECT_ATTEMPTS = 3;
export const MAX_VISION_ATTEMPTS = 3;

export interface StoredPhotoState {
  dropboxId: string;
  path: string;
  contentHash: string;
  inspectedHash: string | null;
  inspectStatus: string | null;
  inspectAttempts: number;
}

export type InspectPlan =
  | { action: "inspect"; reason: "new" | "replaced" | "retry"; attemptsBefore: number }
  | { action: "skip"; reason: "unchanged" | "attempts-exhausted"; moved: boolean };

/** Whether a file must be downloaded and read. Only new or changed bytes are. */
export function planInspect(entry: Pick<DropboxFileEntry, "contentHash" | "displayPath">, stored: StoredPhotoState | undefined): InspectPlan {
  if (!stored) return { action: "inspect", reason: "new", attemptsBefore: 0 };
  if (entry.contentHash !== stored.contentHash) return { action: "inspect", reason: "replaced", attemptsBefore: 0 };
  const moved = entry.displayPath !== stored.path;
  if (stored.inspectStatus === "ok" && stored.inspectedHash === entry.contentHash) return { action: "skip", reason: "unchanged", moved };
  if (stored.inspectAttempts >= MAX_INSPECT_ATTEMPTS) return { action: "skip", reason: "attempts-exhausted", moved };
  return { action: "inspect", reason: "retry", attemptsBefore: stored.inspectAttempts };
}

// ─── The library: groups with what each shows ─────────────────────────

/** A photo row as the library reads it — every column but the thumbnail. */
export interface PhotoRecord {
  id: number;
  dropboxId: string;
  path: string;
  folder: string;
  name: string;
  contentHash: string;
  sizeBytes: number;
  modifiedAt: Date | null;
  kind: string;
  used: boolean;
  groupKey: string;
  isMaster: boolean;
  groupUsed: boolean;
  width: number | null;
  height: number | null;
  megapixels: number | null;
  orientation: string | null;
  takenAt: string | null;
  camera: string | null;
  inspectStatus: string | null;
  inspectError: string | null;
  description: string | null;
  products: string[] | null;
  shotType: string | null;
  people: string[] | null;
  background: string | null;
  visibleText: string | null;
  subjectPosition: string | null;
  headlineSpace: string | null;
  qualityFlags: string[] | null;
  suggestedUses: string[] | null;
  visionModel: string | null;
  describedAt: Date | null;
  describedHash: string | null;
  visionStatus: string | null;
  visionAttempts: number;
  /** The content hash `visionAttempts` counts against. */
  visionAttemptHash: string | null;
  visionError: string | null;
  correctedDescription: string | null;
  correctedProducts: string[] | null;
  correctedShotType: string | null;
  doNotUse: boolean;
  correctionNote: string | null;
  correctedBy: string | null;
  correctedAt: Date | null;
}

/** Where a group stands on being described. */
export type DescriptionState = "described" | "awaiting" | "failed" | "not-described";

export interface PhotoGroup {
  master: PhotoRecord;
  /** Every file of the picture, master first. */
  versions: PhotoRecord[];
  used: boolean;
  doNotUse: boolean;
  /** Correction where there is one, else what the model saw. */
  description: string | null;
  products: string[] | null;
  shotType: string | null;
  state: DescriptionState;
  /** Fields a person or Claude corrected. */
  corrected: { fields: string[]; by: string | null; at: Date | null; note: string | null } | null;
}

/** The most recently corrected file in a group: its corrections speak for the group. */
function latestCorrection(versions: PhotoRecord[]): PhotoRecord | null {
  return versions
    .filter((v) => v.correctedAt !== null)
    .sort((a, b) => b.correctedAt!.getTime() - a.correctedAt!.getTime())[0] ?? null;
}

export function correctedFields(r: Pick<PhotoRecord, "correctedDescription" | "correctedProducts" | "correctedShotType" | "doNotUse">): string[] {
  return [
    ...(r.correctedDescription !== null ? ["description"] : []),
    ...(r.correctedProducts !== null ? ["products"] : []),
    ...(r.correctedShotType !== null ? ["shotType"] : []),
    ...(r.doNotUse ? ["doNotUse"] : []),
  ];
}

export function buildLibrary(rows: PhotoRecord[]): PhotoGroup[] {
  const byGroup = new Map<string, PhotoRecord[]>();
  for (const r of rows) byGroup.set(r.groupKey, [...(byGroup.get(r.groupKey) ?? []), r]);

  const groups: PhotoGroup[] = [];
  for (const members of byGroup.values()) {
    const master = members.find((m) => m.isMaster) ?? members[0];
    const versions = [master, ...members.filter((m) => m !== master)];
    const fix = latestCorrection(versions);
    const described = master.describedHash === master.contentHash && master.visionStatus === "ok";
    const state: DescriptionState =
      master.kind !== "source" ? "not-described"
      : described ? "described"
      : master.visionStatus === "error" && master.visionAttemptHash === master.contentHash && master.visionAttempts >= MAX_VISION_ATTEMPTS ? "failed"
      : "awaiting";
    const fields = fix ? correctedFields(fix) : [];
    groups.push({
      master,
      versions,
      used: members.some((m) => m.used || m.groupUsed),
      doNotUse: members.some((m) => m.doNotUse),
      description: fix?.correctedDescription ?? (described ? master.description : null),
      products: fix?.correctedProducts ?? (described ? master.products : null),
      shotType: fix?.correctedShotType ?? (described ? master.shotType : null),
      state,
      corrected: fix && fields.length > 0 ? { fields, by: fix.correctedBy, at: fix.correctedAt, note: fix.correctionNote } : null,
    });
  }
  return groups.sort((a, b) => a.master.id - b.master.id);
}

// ─── Searching ────────────────────────────────────────────────────────

export interface PhotoFilter {
  product?: string;
  shotType?: string;
  people?: string;
  orientation?: string;
  background?: string;
  /** A kind, or "any". Default "source". */
  kind?: string;
  used?: boolean;
  folder?: string;
  minWidth?: number;
  text?: string;
  includeDoNotUse?: boolean;
}

const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();

/** Every word must appear in what is known of the picture: description, text in it, products, folder and name. */
function matchesText(g: PhotoGroup, text: string): boolean {
  const haystack = [g.description, g.master.visibleText, ...(g.products ?? []), g.master.folder, g.master.name, g.shotType]
    .map(lower)
    .join(" \n ");
  return text.toLowerCase().split(/\s+/).filter(Boolean).every((w) => haystack.includes(w));
}

export function filterGroups(groups: PhotoGroup[], f: PhotoFilter): PhotoGroup[] {
  const kind = f.kind ?? "source";
  return groups.filter((g) => {
    const m = g.master;
    if (kind !== "any" && m.kind !== kind) return false;
    if (!f.includeDoNotUse && g.doNotUse) return false;
    if (f.used !== undefined && g.used !== f.used) return false;
    if (f.product && !(g.products ?? []).some((p) => lower(p).includes(f.product!.toLowerCase()))) return false;
    if (f.shotType && lower(g.shotType) !== f.shotType.toLowerCase()) return false;
    if (f.people && !(m.people ?? []).includes(f.people)) return false;
    if (f.orientation && m.orientation !== f.orientation) return false;
    if (f.background && m.background !== f.background) return false;
    if (f.folder && !lower(m.folder).includes(f.folder.toLowerCase())) return false;
    if (f.minWidth !== undefined && (m.width ?? 0) < f.minWidth) return false;
    if (f.text && !matchesText(g, f.text)) return false;
    return true;
  });
}

// ─── Totals ───────────────────────────────────────────────────────────

const tally = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

/** Counts over every file, so they can be checked against the folder itself. */
export function summariseLibrary(rows: PhotoRecord[], groups: PhotoGroup[]) {
  const sourceGroups = groups.filter((g) => g.master.kind === "source");
  return {
    files: rows.length,
    groups: groups.length,
    filesByKind: Object.fromEntries(PHOTO_KINDS.map((k) => [k, rows.filter((r) => r.kind === k).length])),
    groupsByKind: Object.fromEntries(PHOTO_KINDS.map((k) => [k, groups.filter((g) => g.master.kind === k).length])),
    sourceDescriptions: {
      described: sourceGroups.filter((g) => g.state === "described").length,
      awaiting: sourceGroups.filter((g) => g.state === "awaiting").length,
      failed: sourceGroups.filter((g) => g.state === "failed").length,
    },
    unreadable: rows.filter((r) => r.inspectStatus !== "ok").length,
    doNotUse: groups.filter((g) => g.doNotUse).length,
    usedGroups: groups.filter((g) => g.used).length,
    byFolder: tally(rows.map((r) => r.folder || "(root)")).map(([folder, files]) => ({
      folder,
      files,
      groups: groups.filter((g) => (g.master.folder || "(root)") === folder).length,
    })),
    byProduct: tally(sourceGroups.filter((g) => g.state === "described" || g.corrected).flatMap((g) => (g.products && g.products.length > 0 ? g.products : ["(none visible)"])))
      .map(([product, groups]) => ({ product, groups })),
  };
}
