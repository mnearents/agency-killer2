/**
 * The worker must read the voice profile from the database.
 *
 * Regression guard for a bug where `src/worker/index.ts` called the
 * seed-file-only loader while three separate write paths — the `!voice add`
 * Slack command in that same file, the /voice dashboard, and the API route —
 * all wrote to the database. Every scheduled generation therefore ran off a
 * frozen JSON file, and Tara could add a sample, be told it worked, and never
 * see it used.
 *
 * The failure had no observable symptom: no error, no warning, and a success
 * message on the write. Only a test that asserts the wiring can catch it,
 * because both loaders return a perfectly valid profile.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { loadVoiceProfileWithDb } from "@/domain/voice/loader";
import { vi } from "vitest";

const workerSource = readFileSync(
  join(process.cwd(), "src/worker/index.ts"),
  "utf-8"
);

describe("worker voice profile source", () => {
  it("does not use the seed-file-only loader", () => {
    // Named for what it is, so any future call site reads as obviously wrong.
    expect(workerSource).not.toMatch(/\bloadVoiceProfileFromSeedFile\b/);
  });

  it("loads the profile through the database loader", () => {
    expect(workerSource).toMatch(/loadVoiceProfileWithDb\s*\(\s*db\s*\)/);
  });

  // The worker offers `!voice add`. If it writes to a store it does not read,
  // the command reports success and changes nothing about what gets generated.
  it("reads from the same store its own !voice add command writes to", () => {
    expect(workerSource).toMatch(/addSample\s*\(\s*db\b/);
    expect(workerSource).toMatch(/loadVoiceProfileWithDb\s*\(\s*db\s*\)/);
  });
});

describe("loadVoiceProfileWithDb", () => {
  it("returns the database profile rather than the seed file when rows exist", async () => {
    const dbSamples = [
      { id: "db-1", title: "From DB", content: "written after deploy", tags: [], createdAt: new Date() },
    ];
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(dbSamples),
        }),
      }),
    } as never as Parameters<typeof loadVoiceProfileWithDb>[0];

    const profile = await loadVoiceProfileWithDb(db);

    expect(profile.samples).toHaveLength(1);
    expect(profile.samples[0].content).toBe("written after deploy");
  });
});

/**
 * The corpus sync has to be invoked, and invoked before the profile is read.
 *
 * `syncVoiceCorpus` defined and never called would leave the seed file exactly
 * as inert as it was before it existed, and the boot log would be identical.
 * That is the shape this project keeps producing — see CLAUDE.md, "Assert the
 * call site, not just the behavior" — so the call site is asserted here rather
 * than only the function's behaviour.
 */
describe("worker voice corpus sync", () => {
  it("calls syncVoiceCorpus", () => {
    expect(workerSource).toMatch(/syncVoiceCorpus\s*\(\s*db\b/);
  });

  // #54: the worker printed `Loaded voice profile: 34 samples, 3 rules, 7 banned
  // words` after two failed database calls, because the summary never said where
  // the profile came from. A degraded boot has to be readable as one.
  it("names the profile's source in the line it logs about loading it", () => {
    const summary = workerSource.match(/console\.log\(\s*[\s\S]{0,200}?Loaded voice profile[\s\S]{0,200}?\)/);
    expect(summary, "no `Loaded voice profile` log line found in the worker").not.toBeNull();
    expect(summary![0]).toMatch(/voiceProfile\.source/);
  });

  it("syncs before loading, so the load sees this deploy's corpus", () => {
    // Loading first would serve the previous corpus for the whole process
    // lifetime — the profile is read once at startup and never refreshed.
    const sync = workerSource.search(/syncVoiceCorpus\s*\(\s*db\b/);
    const load = workerSource.search(/loadVoiceProfileWithDb\s*\(\s*db\s*\)/);
    expect(sync).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(sync).toBeLessThan(load);
  });
});
