/**
 * The seed file is the corpus of record; the database is what actually gets
 * read. Until now the only bridge between them was `seedVoiceProfileToDb`,
 * which runs when all three voice tables are empty and never again. Production
 * has held 34 samples since first boot, so every subsequent edit to
 * `voice-profile-seed.json` changed a file nobody reads.
 *
 * That failure is silent in the worst way: the file diff is real, the tests
 * pass, the deploy is green, and the corpus does not move. #27 alone needs four
 * corpus corrections (splitting IGMULTI, the IG13 title collision, channel and
 * intent tags, email and SMS samples), none of which would have landed.
 *
 * The planning is pure so it can be tested without mocking a database. The one
 * rule that matters is the last one: a row with no `sourceKey` was written by a
 * person through the dashboard, the API, or `!voice add`, and the seed file has
 * no authority over it.
 */

import { describe, it, expect } from "vitest";
import { planCorpusSync, type CorpusRow } from "@/domain/voice/corpus-sync";

const seed = (sourceKey: string, content: string, tags: string[] = []) => ({
  sourceKey,
  title: sourceKey,
  content,
  tags,
});

const row = (
  id: string,
  sourceKey: string | null,
  content: string,
  tags: string[] = []
): CorpusRow => ({ id, sourceKey, title: sourceKey ?? id, content, tags });

describe("planCorpusSync", () => {
  it("inserts a seed entry the database has never seen", () => {
    const plan = planCorpusSync([seed("IG1", "hi")], []);
    expect(plan.insert.map((s) => s.sourceKey)).toEqual(["IG1"]);
    expect(plan.update).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("updates a seed entry whose content changed in the file", () => {
    const plan = planCorpusSync([seed("IG1", "new")], [row("uuid-1", "IG1", "old")]);
    expect(plan.update).toEqual([
      { id: "uuid-1", sourceKey: "IG1", title: "IG1", content: "new", tags: [] },
    ]);
    expect(plan.insert).toEqual([]);
  });

  // Without this the sync rewrites all 84 rows on every boot, and updatedAt
  // stops meaning anything.
  it("leaves an unchanged seed entry alone", () => {
    const plan = planCorpusSync([seed("IG1", "same")], [row("uuid-1", "IG1", "same")]);
    expect(plan.update).toEqual([]);
    expect(plan.insert).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  // Tags are the whole point of #27 — a tag added to the file has to reach the
  // database or channel scoping is scoping over an empty tag set.
  it("counts a tag change as a change", () => {
    const plan = planCorpusSync(
      [seed("IG1", "same", ["channel:instagram"])],
      [row("uuid-1", "IG1", "same", [])]
    );
    expect(plan.update).toHaveLength(1);
    expect(plan.update[0].tags).toEqual(["channel:instagram"]);
  });

  // IGMULTI is removed from the file and replaced by 51 captions. The blob has
  // to go, or the thing the split exists to fix survives the split.
  it("deletes a row whose seed entry was removed from the file", () => {
    const plan = planCorpusSync(
      [seed("IGM01", "first caption")],
      [row("uuid-blob", "IGMULTI", "forty captions in a trench coat")]
    );
    expect(plan.delete).toEqual(["uuid-blob"]);
    expect(plan.insert.map((s) => s.sourceKey)).toEqual(["IGM01"]);
  });

  // The rule the rest of this exists to protect. `!voice add` writes a row with
  // no sourceKey, tells Tara it worked, and she has no way to check. A sync
  // that treats "not in the file" as "delete" would remove her sample on the
  // next deploy and report a successful boot.
  it("never touches a row a person added", () => {
    const plan = planCorpusSync(
      [seed("IG1", "hi")],
      [row("uuid-1", "IG1", "hi"), row("uuid-hers", null, "sample Tara added")]
    );
    expect(plan.delete).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.userOwned).toBe(1);
  });

  it("does not adopt a person's row just because its content matches a seed entry", () => {
    const plan = planCorpusSync([seed("IG1", "hi")], [row("uuid-hers", null, "hi")]);
    expect(plan.insert.map((s) => s.sourceKey)).toEqual(["IG1"]);
    expect(plan.delete).toEqual([]);
  });

  // Fail closed. An unreadable or truncated seed file parses to zero samples,
  // and "delete everything the file no longer mentions" would then empty the
  // corpus and log a clean run. Deleting 34 rows is never the intent of a file
  // that mentions none.
  it("refuses to plan anything from an empty seed set", () => {
    expect(() => planCorpusSync([], [row("uuid-1", "IG1", "hi")])).toThrow(/empty/i);
  });

  it("rejects a seed set with duplicate source keys rather than picking one", () => {
    expect(() => planCorpusSync([seed("IG13", "a"), seed("IG13", "b")], [])).toThrow(
      /IG13/
    );
  });

  it("rejects a seed entry with no source key, which would be unmatchable forever", () => {
    expect(() => planCorpusSync([{ ...seed("IG1", "hi"), sourceKey: "" }], [])).toThrow(
      /source key/i
    );
  });
});
