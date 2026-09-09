/**
 * The seed-file loader, plus the distinction that made #54 undetectable.
 *
 * `loadVoiceProfileFromDb` collapsed every error into `null`, and its caller
 * read `null` as "the database is empty". An unreachable database and an empty
 * one are not the same condition, but they produced the same return value, the
 * same fallback, and the same success line — so on 2026-09-09 the worker booted
 * against a database missing `source_key`, failed twice, fell back to the file,
 * and logged `Loaded voice profile: 34 samples, 3 rules, 7 banned words`: the
 * exact line a healthy read prints.
 *
 * The rule these tests hold is that a degraded read is distinguishable from a
 * healthy one *in the return value*, not only in a log line someone has to
 * notice sitting above a success message.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { loadVoiceProfileFromSeedFile, loadVoiceProfileWithDb } from "@/domain/voice/loader";
import { readVoiceProfileFromDb } from "@/domain/voice/queries";
import { validateVoiceProfile } from "@/domain/voice/voice";
import type { Db } from "@/db/client";

/** A db whose reads all resolve to `rows`. */
const dbReturning = (rows: unknown[]) =>
  ({
    select: () => ({ from: () => ({ orderBy: () => Promise.resolve(rows) }) }),
  }) as unknown as Db;

/** A db whose reads all reject — a missing column, a dead connection. */
const dbFailing = (message: string) =>
  ({
    select: () => ({
      from: () => ({ orderBy: () => Promise.reject(new Error(message)) }),
    }),
  }) as unknown as Db;

describe("loadVoiceProfileFromSeedFile", () => {
  it("loads the seed file with real samples", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.samples.length).toBeGreaterThan(0);
  });

  it("loads at least 30 writing samples", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.samples.length).toBeGreaterThanOrEqual(30);
  });

  it("every sample has non-empty content", () => {
    const profile = loadVoiceProfileFromSeedFile();
    for (const sample of profile.samples) {
      expect(sample.content.length).toBeGreaterThan(0);
      expect(sample.id).toBeDefined();
    }
  });

  it("loads brand rules", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.rules.length).toBeGreaterThan(0);
    expect(profile.rules).toContain("Never use em dashes");
  });

  it("loads banned words", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.bannedWords.length).toBeGreaterThan(0);
    expect(profile.bannedWords).toContain("synergy");
  });

  it("produces a valid voice profile", () => {
    const profile = loadVoiceProfileFromSeedFile();
    const validation = validateVoiceProfile(profile);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});

describe("readVoiceProfileFromDb", () => {
  it("reports a populated corpus as loaded", async () => {
    const read = await readVoiceProfileFromDb(
      dbReturning([{ id: "1", title: "IG1", content: "hi", tags: [] }])
    );
    expect(read.status).toBe("loaded");
  });

  // The distinction the whole file exists for. Both of these used to be `null`.
  it("reports a genuinely empty corpus as empty", async () => {
    const read = await readVoiceProfileFromDb(dbReturning([]));
    expect(read.status).toBe("empty");
  });

  it("reports an unreadable corpus as unavailable, not as empty", async () => {
    const read = await readVoiceProfileFromDb(
      dbFailing('column "source_key" of relation "voice_samples" does not exist')
    );
    expect(read.status).toBe("unavailable");
  });

  // Without the cause the operator sees "unavailable" and has to go find out
  // why from a stack trace that may already have scrolled.
  it("carries the underlying error so the reason is not lost", async () => {
    const read = await readVoiceProfileFromDb(dbFailing("connection refused"));
    if (read.status !== "unavailable") throw new Error("expected unavailable");
    expect(String(read.error)).toMatch(/connection refused/);
  });
});

describe("loadVoiceProfileWithDb logging", () => {
  const capture = () => {
    const lines: string[] = [];
    const push = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(push);
    vi.spyOn(console, "warn").mockImplementation(push);
    vi.spyOn(console, "error").mockImplementation(push);
    return lines;
  };

  afterEach(() => vi.restoreAllMocks());

  it("still returns a usable profile when the database cannot be read", async () => {
    // Generation must not stop because the corpus is unreachable; the seed file
    // is a worse corpus, not no corpus.
    const profile = await loadVoiceProfileWithDb(dbFailing("boom"));
    expect(profile.samples.length).toBeGreaterThan(0);
  });

  it("says the corpus is unreachable, not that it loaded one", async () => {
    const lines = capture();
    await loadVoiceProfileWithDb(dbFailing("boom"));
    const text = lines.join("\n");
    expect(text).toMatch(/unreachable|unavailable|could not read/i);
    // "Loaded from DB" on a read that never reached the DB is the exact
    // sentence that hid #54 for a full deploy cycle.
    expect(text).not.toMatch(/Loaded from DB/i);
  });

  it("reports the fallback through console.error, so it is not styled as routine", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await loadVoiceProfileWithDb(dbFailing("boom"));
    expect(err).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("does not try to seed a database it could not read", async () => {
    // Seeding on an unavailable read is how the old code turned one failure
    // into two, and the second one is what wrote 34 duplicate rows' worth of
    // attempted inserts to the log.
    const insert = vi.fn();
    const db = {
      select: () => ({
        from: () => ({ orderBy: () => Promise.reject(new Error("boom")) }),
      }),
      insert,
    } as unknown as Db;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await loadVoiceProfileWithDb(db);
    expect(insert).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

/**
 * The source has to survive the return, not just reach a log line inside the
 * loader. The line an operator actually reads is printed by the caller.
 */
describe("loadVoiceProfileWithDb source", () => {
  it("reports a real database read as coming from the database", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const p = await loadVoiceProfileWithDb(
      dbReturning([{ id: "1", title: "IG1", content: "hi", tags: [] }])
    );
    expect(p.source).toBe("database");
    vi.restoreAllMocks();
  });

  it("distinguishes an unreachable database from an empty one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unreachable = await loadVoiceProfileWithDb(dbFailing("boom"));
    const empty = await loadVoiceProfileWithDb({
      ...(dbReturning([]) as object),
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as Db);
    expect(unreachable.source).not.toBe(empty.source);
    expect(unreachable.source).toMatch(/unreachable/);
    vi.restoreAllMocks();
  });
});
