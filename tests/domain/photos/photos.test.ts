import { describe, it, expect } from "vitest";
import {
  isPhotoFile,
  folderOf,
  photoKind,
  isUsedFolder,
  versionKey,
  orientationOf,
  megapixelsOf,
  groupPhotos,
  planInspect,
  buildLibrary,
  filterGroups,
  summariseLibrary,
  type GroupMember,
  type PhotoRecord,
} from "@/domain/photos/photos";

const ROOT = "/RAD/Footage";

describe("what a file is", () => {
  it("takes .jpg, .jpeg, .png and .webp in any case, and nothing else", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.webp"]) expect(isPhotoFile({ name, isFolder: false })).toBe(true);
    for (const name of [".DS_Store", "a.mov", "a.ai", "a.heic", "jpg"]) expect(isPhotoFile({ name, isFolder: false })).toBe(false);
    expect(isPhotoFile({ name: "pictures.jpg", isFolder: true })).toBe(false);
  });

  it("names the folder under the footage root, capitals kept", () => {
    expect(folderOf("/RAD/Footage/Planners/2027 planner pictures/8x10 dated/x.jpg", ROOT)).toBe("Planners/2027 planner pictures/8x10 dated");
    expect(folderOf("/rad/footage/x.jpg", ROOT)).toBe("");
  });

  it("is an old graphic anywhere under Old ad stuff to organize or Finished Ads, a screenshot by its name, else a source photo", () => {
    expect(photoKind("Old ad stuff to organize/ADS MASTER/Baby Quilt", "img.png")).toBe("old-graphic");
    expect(photoKind("Finished Ads", "still.jpg")).toBe("old-graphic");
    expect(photoKind("Planners/2027 planner pictures/5x8 dated", "Screenshot 2026-09-26 at 11.04.57 AM.png")).toBe("screenshot");
    expect(photoKind("Planners/Oct ad shoot", "Photo Oct 09 2026.jpg")).toBe("source");
  });

  it("is used when a folder in its path is named used — not when a name merely contains it", () => {
    expect(isUsedFolder("Planners/2027 planner pictures/5x8 undated/used")).toBe(true);
    expect(isUsedFolder("Planners/Used/x")).toBe(true);
    expect(isUsedFolder("Planners/unused shots")).toBe(false);
  });

  it("gives portrait, landscape or square, and megapixels", () => {
    expect(orientationOf(720, 1280)).toBe("portrait");
    expect(orientationOf(1280, 720)).toBe("landscape");
    expect(orientationOf(1000, 990)).toBe("square");
    expect(megapixelsOf(4032, 3024)).toBe(12.2);
  });
});

describe("version groups", () => {
  // The brief's example: one picture at two sizes, the big one under "too big".
  const LARGE = { folder: "Planners/2027 planner pictures/8x10 dated", name: "37FEB8CC-1A81-4DA0-836D-343B630672D4 Large.jpeg" };
  const BIG = { folder: "Planners/2027 planner pictures/8x10 dated/too big", name: "37FEB8CC-1A81-4DA0-836D-343B630672D4.jpg" };

  it("gives the 'Large' copy and the 'too big' original the same version name", () => {
    expect(versionKey(LARGE.folder, LARGE.name)).toBe(versionKey(BIG.folder, BIG.name));
    expect(versionKey(LARGE.folder, LARGE.name)).toBe("planners/2027 planner pictures/8x10 dated/37feb8cc-1a81-4da0-836d-343b630672d4");
  });

  it("treats a used folder as its parent's, and keeps other folders apart", () => {
    expect(versionKey("A/5x8 undated/used", "x.png")).toBe(versionKey("A/5x8 undated", "x Large.jpeg"));
    expect(versionKey("A/5x8 dated", "x.png")).not.toBe(versionKey("A/5x8 undated", "x.png"));
  });

  const member = (id: number, over: Partial<GroupMember>): GroupMember => ({
    id, folder: "F", name: `${id}.jpg`, path: `/RAD/Footage/F/${id}.jpg`, contentHash: `h${id}`, sizeBytes: 1000, width: 100, height: 100, used: false, ...over,
  });

  it("makes the 37FEB8CC pair one group whose master is the 'too big' file", () => {
    const grouped = groupPhotos([
      member(1, { ...LARGE, width: 720, height: 1280, sizeBytes: 203_742 }),
      member(2, { ...BIG, width: 3024, height: 4032, sizeBytes: 13_225_735 }),
    ]);
    expect(grouped.get(1)!.groupKey).toBe(grouped.get(2)!.groupKey);
    expect(grouped.get(2)!.isMaster).toBe(true);
    expect(grouped.get(1)!.isMaster).toBe(false);
  });

  it("joins identical bytes under different names, and joins groups through them", () => {
    const grouped = groupPhotos([
      member(1, { name: "photo.jpg", contentHash: "same" }),
      member(2, { name: "photo (1).jpg", contentHash: "same" }),
      member(3, { name: "photo (1) Large.jpeg", contentHash: "other" }),
      member(4, { name: "elsewhere.jpg" }),
    ]);
    const key = grouped.get(1)!.groupKey;
    expect([2, 3].map((id) => grouped.get(id)!.groupKey)).toEqual([key, key]);
    expect(grouped.get(4)!.groupKey).not.toBe(key);
    expect([1, 2, 3].filter((id) => grouped.get(id)!.isMaster)).toHaveLength(1);
  });

  it("marks the whole group used when any version sits under used", () => {
    const grouped = groupPhotos([member(1, { folder: "A", name: "x.jpg" }), member(2, { folder: "A/used", name: "x.png", used: true })]);
    expect(grouped.get(1)!.groupUsed).toBe(true);
  });

  it("keeps the group's name when a bigger version arrives", () => {
    const before = groupPhotos([member(1, { ...LARGE })]).get(1)!.groupKey;
    const after = groupPhotos([member(1, { ...LARGE }), member(2, { ...BIG, width: 5000, height: 5000 })]).get(1)!.groupKey;
    expect(after).toBe(before);
  });
});

describe("planInspect", () => {
  const entry = { contentHash: "h1", displayPath: "/RAD/Footage/a.jpg" };
  const stored = { dropboxId: "id:a", path: "/RAD/Footage/a.jpg", contentHash: "h1", inspectedHash: "h1", inspectStatus: "ok", inspectAttempts: 1 };

  it("reads a new file and a replaced one, and nothing that has not changed", () => {
    expect(planInspect(entry, undefined)).toEqual({ action: "inspect", reason: "new", attemptsBefore: 0 });
    expect(planInspect({ ...entry, contentHash: "h2" }, stored)).toEqual({ action: "inspect", reason: "replaced", attemptsBefore: 0 });
    expect(planInspect(entry, stored)).toEqual({ action: "skip", reason: "unchanged", moved: false });
  });

  it("moves a renamed file without reading it", () => {
    expect(planInspect({ ...entry, displayPath: "/RAD/Footage/b.jpg" }, stored)).toEqual({ action: "skip", reason: "unchanged", moved: true });
  });

  it("retries an unreadable file three times, then leaves it", () => {
    expect(planInspect(entry, { ...stored, inspectStatus: "error", inspectAttempts: 2 })).toEqual({ action: "inspect", reason: "retry", attemptsBefore: 2 });
    expect(planInspect(entry, { ...stored, inspectStatus: "error", inspectAttempts: 3 })).toEqual({ action: "skip", reason: "attempts-exhausted", moved: false });
  });
});

const record = (id: number, over: Partial<PhotoRecord> = {}): PhotoRecord => ({
  id, dropboxId: `id:${id}`, path: `/RAD/Footage/F/${id}.jpg`, folder: "F", name: `${id}.jpg`, contentHash: `h${id}`, sizeBytes: 1_048_576,
  modifiedAt: null, kind: "source", used: false, groupKey: `g${id}`, isMaster: true, groupUsed: false,
  width: 2000, height: 3000, megapixels: 6, orientation: "portrait", takenAt: null, camera: null, inspectStatus: "ok", inspectError: null,
  description: `Photo ${id}.`, products: ["2027 Planner"], shotType: "flat lay", people: ["none"], background: "light", visibleText: null,
  subjectPosition: "centered", headlineSpace: "top", qualityFlags: ["sharp"], suggestedUses: ["email hero"],
  visionModel: "claude-sonnet-4-6", describedAt: new Date("2026-11-16T00:00:00Z"), describedHash: `h${id}`, visionStatus: "ok",
  visionAttempts: 1, visionAttemptHash: `h${id}`, visionError: null,
  correctedDescription: null, correctedProducts: null, correctedShotType: null, doNotUse: false, correctionNote: null, correctedBy: null, correctedAt: null,
  ...over,
});

describe("the library", () => {
  it("is one entry per picture, master first, described by the master", () => {
    const [g] = buildLibrary([
      record(1, { groupKey: "g", isMaster: false, width: 720, height: 1280, description: null, describedHash: null, visionStatus: null }),
      record(2, { groupKey: "g" }),
    ]);
    expect(g.master.id).toBe(2);
    expect(g.versions.map((v) => v.id)).toEqual([2, 1]);
    expect(g.description).toBe("Photo 2.");
    expect(g.state).toBe("described");
  });

  it("puts a correction before the model's reading, from the most recent corrected version", () => {
    const [g] = buildLibrary([
      record(1, { groupKey: "g", correctedProducts: ["Old"], correctedAt: new Date("2026-11-01") }),
      record(2, { groupKey: "g", isMaster: false, correctedProducts: ["2027 Planner - 8x10 Dated"], correctedShotType: "in hand", correctedAt: new Date("2026-11-10") }),
    ]);
    expect(g.products).toEqual(["2027 Planner - 8x10 Dated"]);
    expect(g.shotType).toBe("in hand");
    expect(g.description).toBe("Photo 1.");
    expect(g.corrected?.fields).toEqual(["products", "shotType"]);
  });

  it("does not offer a stale description of bytes that were replaced", () => {
    const [g] = buildLibrary([record(1, { contentHash: "new" })]);
    expect(g.state).toBe("awaiting");
    expect(g.description).toBeNull();
  });

  it("calls a picture failed only after three failures on its current bytes", () => {
    const failing = { describedHash: null, visionStatus: "error", visionAttempts: 3 };
    expect(buildLibrary([record(1, { ...failing, visionAttemptHash: "h1" })])[0].state).toBe("failed");
    expect(buildLibrary([record(1, { ...failing, visionAttemptHash: "older" })])[0].state).toBe("awaiting");
  });

  it("never calls an old graphic awaiting a description: they are not described", () => {
    expect(buildLibrary([record(1, { kind: "old-graphic", description: null, describedHash: null, visionStatus: null })])[0].state).toBe("not-described");
  });
});

describe("filterGroups", () => {
  const library = buildLibrary([
    record(1, { products: ["2027 Planner - 8x10 Dated"], people: ["hands only"], orientation: "portrait" }),
    record(2, { kind: "screenshot" }),
    record(3, { kind: "old-graphic" }),
    record(4, { doNotUse: true, correctedAt: new Date() }),
    record(5, { groupKey: "g5", used: true, orientation: "landscape", width: 4000, products: [] }),
    record(6, { groupKey: "g5", isMaster: false, width: 100 }),
    record(7, { description: "A child colouring a doodle book on a kitchen table.", products: ["unknown"] }),
  ]);
  const ids = (f: Parameters<typeof filterGroups>[1]) => filterGroups(library, f).map((g) => g.master.id);

  it("by default lists source pictures once each, without do-not-use ones", () => {
    expect(ids({})).toEqual([1, 5, 7]);
  });

  it("lists other kinds on request, and do-not-use ones when asked", () => {
    expect(ids({ kind: "screenshot" })).toEqual([2]);
    expect(ids({ kind: "any" })).toEqual([1, 2, 3, 5, 7]);
    expect(ids({ includeDoNotUse: true })).toEqual([1, 4, 5, 7]);
  });

  it("filters on product, people, orientation, used, width and words", () => {
    expect(ids({ product: "8x10" })).toEqual([1]);
    expect(ids({ people: "hands only" })).toEqual([1]);
    expect(ids({ orientation: "landscape" })).toEqual([5]);
    expect(ids({ used: true })).toEqual([5]);
    expect(ids({ used: false })).toEqual([1, 7]);
    expect(ids({ minWidth: 3000 })).toEqual([5]);
    expect(ids({ text: "kitchen child" })).toEqual([7]);
    expect(ids({ text: "kitchen garden" })).toEqual([]);
  });
});

describe("summariseLibrary", () => {
  it("counts every file by kind, so the totals can be checked against the folder", () => {
    const rows = [
      record(1, { groupKey: "g" }),
      record(2, { groupKey: "g", isMaster: false, folder: "F/too big" }),
      record(3, { kind: "screenshot", description: null, describedHash: null, visionStatus: null }),
      record(4, { kind: "old-graphic", folder: "Old ad stuff to organize" }),
      record(5, { description: null, describedHash: null, visionStatus: null }),
    ];
    const s = summariseLibrary(rows, buildLibrary(rows));
    expect(s.files).toBe(5);
    expect(s.groups).toBe(4);
    expect(s.filesByKind).toEqual({ source: 3, screenshot: 1, "old-graphic": 1 });
    expect(s.sourceDescriptions).toEqual({ described: 1, awaiting: 1, failed: 0 });
    expect(s.byFolder).toEqual([
      { folder: "F", files: 3, groups: 3 },
      { folder: "F/too big", files: 1, groups: 0 },
      { folder: "Old ad stuff to organize", files: 1, groups: 1 },
    ]);
    expect(s.byProduct).toEqual([{ product: "2027 Planner", groups: 1 }]);
  });
});
