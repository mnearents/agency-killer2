/**
 * Properties the authored corpus has to hold, asserted against the seed file.
 *
 * These are not style preferences. Few-shot examples are the strongest signal
 * in a generation prompt, and they are weighted by the space they occupy — so a
 * corpus can be quietly broken by its shape alone, with every individual entry
 * looking fine.
 *
 * `IGMULTI` was that: roughly forty unrelated captions concatenated into one
 * record — a planner launch, a trip to Iceland, a puppy, a pen review — at
 * 16,724 characters against a median of 332. One entry was 57% of the corpus by
 * volume and represented no coherent voice at all, which is the most likely
 * single cause of the drift #27 was opened about.
 */

import { describe, it, expect } from "vitest";
import { loadVoiceProfileFromSeedFile } from "@/domain/voice/loader";

const profile = loadVoiceProfileFromSeedFile();
const total = profile.samples.reduce((n, s) => n + s.content.length, 0);

describe("voice corpus shape", () => {
  it("has samples at all, so the assertions below are not vacuous", () => {
    expect(profile.samples.length).toBeGreaterThan(10);
    expect(total).toBeGreaterThan(1000);
  });

  // The guard that would have caught IGMULTI. A single entry worth more than a
  // tenth of the prompt drowns out everything it is supposed to sit beside,
  // and nothing about the corpus reads as wrong while it does.
  it("lets no single sample exceed a tenth of the corpus", () => {
    for (const s of profile.samples) {
      const share = s.content.length / total;
      expect(
        share,
        `${s.title} is ${(share * 100).toFixed(1)}% of the corpus ` +
          `(${s.content.length} of ${total} chars) and will dominate any prompt it appears in`
      ).toBeLessThan(0.1);
    }
  });

  // A caption is one post. Anything this long is several, concatenated —
  // which is exactly how IGMULTI got in.
  it("keeps every sample within the length of a plausible single caption", () => {
    for (const s of profile.samples) {
      expect(s.content.length, s.title).toBeLessThan(2500);
    }
  });

  // Titles are how samples are referred to in issues, in Slack, and by anything
  // that addresses one directly. Two rows answering to IG13 makes every such
  // reference ambiguous.
  it("gives every sample a distinct title", () => {
    const titles = profile.samples.map((s) => s.title);
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes, `duplicate sample titles: ${[...new Set(dupes)].join(", ")}`).toEqual([]);
  });

  // source_key is what the DB sync matches on, so a collision or a blank makes
  // a sample unmatchable and it is re-inserted on every boot.
  it("gives every sample a distinct, non-empty id", () => {
    const ids = profile.samples.map((s) => s.id);
    for (const id of ids) expect(id?.trim()).toBeTruthy();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has no empty sample", () => {
    for (const s of profile.samples) {
      expect(s.content.trim(), s.title).not.toBe("");
    }
  });
});
