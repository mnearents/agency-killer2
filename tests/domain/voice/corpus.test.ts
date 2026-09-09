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

/**
 * Every sample carries exactly one `channel:` and one `intent:` tag.
 *
 * `brand_voice(channel)` selects by these, so an untagged sample is a sample no
 * generation can ever reach — and it fails silently, as a smaller result set
 * rather than an error. Before #27 all 84 samples were `tags: []`, which meant
 * every channel filter returned nothing and read as "no samples for instagram".
 *
 * The assertions here are about well-formedness, deliberately not about the
 * distribution. A test that expects, say, a tenth of the corpus to be
 * `intent:educational` is a threshold picked to match what happens to be in the
 * file today, and the next honest edit turns it red for no reason.
 */
const CHANNELS = ["instagram", "email", "sms", "ad", "product_page"] as const;
const INTENTS = ["launch", "nurture", "story", "educational", "promo"] as const;

const namespaced = (s: { tags?: string[] }, prefix: string) =>
  (s.tags ?? []).filter((t) => t.startsWith(`${prefix}:`));

describe("voice corpus tags", () => {
  it("gives every sample exactly one channel", () => {
    for (const s of profile.samples) {
      const got = namespaced(s, "channel");
      expect(got, `${s.title} has channel tags: [${got.join(", ")}]`).toHaveLength(1);
    }
  });

  it("gives every sample exactly one intent", () => {
    for (const s of profile.samples) {
      const got = namespaced(s, "intent");
      expect(got, `${s.title} has intent tags: [${got.join(", ")}]`).toHaveLength(1);
    }
  });

  // A typo'd channel is not a smaller result set, it is a sample that belongs
  // to a channel nothing will ever ask for.
  it("uses only channels the system knows about", () => {
    const known = CHANNELS.map((c) => `channel:${c}`);
    for (const s of profile.samples) {
      for (const t of namespaced(s, "channel")) {
        expect(known, `${s.title} carries an unknown ${t}`).toContain(t);
      }
    }
  });

  it("uses only intents the system knows about", () => {
    const known = INTENTS.map((i) => `intent:${i}`);
    for (const s of profile.samples) {
      for (const t of namespaced(s, "intent")) {
        expect(known, `${s.title} carries an unknown ${t}`).toContain(t);
      }
    }
  });

  // Tagging all 84 samples `intent:story` satisfies every assertion above while
  // classifying nothing. This is the cheapest guard against that.
  it("actually distinguishes intents rather than labelling everything the same", () => {
    const used = new Set(profile.samples.flatMap((s) => namespaced(s, "intent")));
    expect([...used].sort().join(", ")).not.toBe("");
    expect(used.size).toBeGreaterThan(1);
  });

  // Anything outside the two namespaces is a tag no filter reads, so it is
  // either a typo'd prefix or a scheme someone added without a consumer.
  it("carries no tag outside the two namespaces it defines", () => {
    for (const s of profile.samples) {
      for (const t of s.tags ?? []) {
        expect(
          t.startsWith("channel:") || t.startsWith("intent:"),
          `${s.title} carries "${t}", which nothing selects on`
        ).toBe(true);
      }
    }
  });
});
