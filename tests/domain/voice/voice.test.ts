import { describe, it, expect } from "vitest";
import {
  assembleVoicePrompt,
  selectSamples,
  describeSampleSelection,
  validateVoiceProfile,
  type VoiceProfile,
  type WritingSample,
} from "@/domain/voice/voice";
import {
  CHANNELS,
  UNSPECIFIED,
  channelTag,
  type Channel,
} from "@/domain/voice/rules";
import { voiceCheck } from "@/domain/voice/voice-check";

const SAMPLE_PROFILES: WritingSample[] = [
  {
    id: "1",
    title: "Planner Launch",
    content:
      "Y'all our new daily planner is HERE and I'm so dang excited!! It's got all the things you've been asking for ✨",
    tags: ["product-launch", "planner"],
  },
  {
    id: "2",
    title: "Thank You Post",
    content:
      "I just want to say thank you from the bottom of my heart. You guys are the reason we get to do this every single day 💛",
    tags: ["gratitude", "community"],
  },
  {
    id: "3",
    title: "Sale Announcement",
    content:
      "Okay friends, this is not a drill — 25% off EVERYTHING in the shop this weekend only! Use code RADWEEKEND 🎉",
    tags: ["sale", "promo"],
  },
];

const BASIC_PROFILE: VoiceProfile = {
  samples: SAMPLE_PROFILES,
  rules: ["Never use em dashes", "No vulgarity"],
  bannedWords: ["synergy", "delve", "leverage", "shenanigans"],
};

describe("assembleVoicePrompt: system prompt construction", () => {
  it("includes all writing samples in the system prompt", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    for (const sample of SAMPLE_PROFILES) {
      expect(systemPrompt).toContain(sample.content);
    }
  });

  it("labels each sample with a number for clarity", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(systemPrompt).toContain("Example 1:");
    expect(systemPrompt).toContain("Example 2:");
    expect(systemPrompt).toContain("Example 3:");
  });

  it("includes all brand rules in the system prompt", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(systemPrompt).toContain("Never use em dashes");
    expect(systemPrompt).toContain("No vulgarity");
  });

  it("includes banned words as an explicit prohibition list", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(systemPrompt).toContain("synergy");
    expect(systemPrompt).toContain("delve");
    expect(systemPrompt).toContain("leverage");
    expect(systemPrompt).toContain("shenanigans");
  });

  it("instructs the model to match the voice of the examples", () => {
    const { systemPrompt } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    // The prompt must contain instruction to study and match the examples
    expect(systemPrompt.toLowerCase()).toMatch(
      /voice|tone|style|match|study|examples/
    );
  });
});

describe("assembleVoicePrompt: guardrail options", () => {
  it("passes banned words to guardrail options", () => {
    const { guardrailOptions } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(guardrailOptions.bannedWords).toEqual([
      "synergy",
      "delve",
      "leverage",
      "shenanigans",
    ]);
  });

  it("enables PII checking by default", () => {
    const { guardrailOptions } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(guardrailOptions.checkPii).toBe(true);
  });

  it("enables fabricated stats checking by default", () => {
    const { guardrailOptions } = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(guardrailOptions.checkFabricatedStats).toBe(true);
  });
});

describe("assembleVoicePrompt: determinism", () => {
  it("same profile produces identical prompt every time", () => {
    const result1 = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    const result2 = assembleVoicePrompt(BASIC_PROFILE, UNSPECIFIED);
    expect(result1.systemPrompt).toBe(result2.systemPrompt);
    expect(result1.guardrailOptions).toEqual(result2.guardrailOptions);
  });
});

describe("assembleVoicePrompt: custom template", () => {
  it("uses custom prompt template when provided", () => {
    const profile: VoiceProfile = {
      ...BASIC_PROFILE,
      promptTemplate:
        "You write for Rad & Happy. {{SAMPLES}} Follow these rules: {{RULES}} Never use: {{BANNED_WORDS}}",
    };
    const { systemPrompt } = assembleVoicePrompt(profile, UNSPECIFIED);
    expect(systemPrompt).toContain("You write for Rad & Happy");
    // Samples should be interpolated
    expect(systemPrompt).toContain(SAMPLE_PROFILES[0].content);
  });
});

describe("validateVoiceProfile: rejects incomplete profiles", () => {
  it("rejects a profile with zero samples", () => {
    const result = validateVoiceProfile({
      samples: [],
      rules: ["No vulgarity"],
      bannedWords: ["delve"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a profile with an empty-content sample", () => {
    const result = validateVoiceProfile({
      samples: [{ id: "1", title: "Empty", content: "", tags: [] }],
      rules: [],
      bannedWords: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("accepts a valid profile", () => {
    const result = validateVoiceProfile(BASIC_PROFILE);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

/**
 * ─── Channel scoping (#27, task 3) ────────────────────────────────────
 *
 * `voiceCheck` has been scoped per channel since #59; `assembleVoicePrompt` was
 * not. The model was therefore steered by one rule set and graded against
 * another, and the gap ran in the harmful direction: generating an Instagram
 * caption, the prompt listed
 *
 *   Don't say "comments get" as if you're writing an instagram post.
 *   Don't say "link in bio" outside instagram.
 *
 * both of which are `exceptIn: ["instagram"]`. The model reads two prohibitions,
 * does not reliably honour the "outside instagram" qualifier, and suppresses a
 * convention that appears in five of Tara's own captions (IG2, IG6, IG8, IG19,
 * IG32). That is the degradation `rules.ts` was written to prevent — "enforcing
 * it globally would degrade the channel where the convention belongs" — shipped
 * as the default.
 */

const IG_ONLY = 'Don\'t say "comments get" as if you\'re writing an instagram post.';
const BIO_ONLY = 'Don\'t say "link in bio" outside instagram.';
const ALL_RULES = ["Never use em dashes", "No vulgarity", IG_ONLY, BIO_ONLY];

function tagged(id: string, channel: Channel | null, content = `copy ${id}`): WritingSample {
  return {
    id,
    title: id,
    content,
    tags: channel ? [channelTag(channel), "intent:story"] : ["intent:story"],
  };
}

const MIXED_PROFILE: VoiceProfile = {
  samples: [
    tagged("ig1", "instagram"),
    tagged("ig2", "instagram"),
    tagged("em1", "email"),
    tagged("untagged", null),
  ],
  rules: ALL_RULES,
  bannedWords: ["synergy"],
};

describe("assembleVoicePrompt: the audience is required and fails closed", () => {
  // TypeScript makes the argument mandatory, but types are erased at runtime and
  // this module is reachable from an API route. An audience nobody meant to name
  // selects a rule set nobody meant to apply — the same reasoning that makes
  // `voiceCheck` refuse an unknown channel rather than report a clean pass over
  // zero rules. There is no result type to carry an error here, so it throws.
  it.each(["insta", "Instagram", "e-mail", "", "channel:instagram", null, undefined, 7])(
    "refuses to build a prompt for %o rather than guessing an audience",
    (bad) => {
      expect(() =>
        assembleVoicePrompt(MIXED_PROFILE, bad as never)
      ).toThrow(/audience/i);
    }
  );

  it("accepts every real channel and the deliberate absence of one", () => {
    for (const c of [...CHANNELS, UNSPECIFIED]) {
      expect(() => assembleVoicePrompt(MIXED_PROFILE, c)).not.toThrow();
    }
  });

  it("reports the audience it built for", () => {
    expect(assembleVoicePrompt(MIXED_PROFILE, "email").audience).toBe("email");
  });
});

describe("assembleVoicePrompt: rules are scoped to the audience", () => {
  it("omits the instagram-excused rules from an instagram prompt", () => {
    const { systemPrompt } = assembleVoicePrompt(MIXED_PROFILE, "instagram");
    expect(systemPrompt).not.toContain(IG_ONLY);
    expect(systemPrompt).not.toContain(BIO_ONLY);
  });

  it("still applies the global rules on instagram", () => {
    const { systemPrompt } = assembleVoicePrompt(MIXED_PROFILE, "instagram");
    expect(systemPrompt).toContain("Never use em dashes");
    expect(systemPrompt).toContain("No vulgarity");
  });

  it("keeps the instagram-scoped rules on every other channel", () => {
    for (const c of CHANNELS.filter((c) => c !== "instagram")) {
      const { systemPrompt } = assembleVoicePrompt(MIXED_PROFILE, c);
      expect(systemPrompt, c).toContain(IG_ONLY);
      expect(systemPrompt, c).toContain(BIO_ONLY);
    }
  });

  it("is excused from nothing when the audience is unspecified", () => {
    const { systemPrompt } = assembleVoicePrompt(MIXED_PROFILE, UNSPECIFIED);
    for (const r of ALL_RULES) expect(systemPrompt).toContain(r);
  });

  /**
   * The asymmetry test, and the reason this task exists. Whatever the model is
   * told and whatever it is graded against have to be the same set, on every
   * audience. Asserted against the rendered prompt text rather than the
   * metadata, because the prompt string is what reaches the model.
   */
  it.each([...CHANNELS, UNSPECIFIED])(
    "tells the model exactly the rules voiceCheck grades it against, on %s",
    (audience) => {
      const { systemPrompt, rules } = assembleVoicePrompt(MIXED_PROFILE, audience);
      const check = voiceCheck("some clean copy", audience, MIXED_PROFILE);
      const graded = [...check.enforced, ...check.unenforced].sort();

      expect(rules.map((r) => r.text).sort()).toEqual(graded);

      for (const r of ALL_RULES) {
        if (graded.includes(r)) expect(systemPrompt, r).toContain(r);
        else expect(systemPrompt, r).not.toContain(r);
      }
    }
  );

  it("carries how each rule is enforced, so an unenforced rule never looks checked", () => {
    const profile: VoiceProfile = {
      ...MIXED_PROFILE,
      rules: ["Never use em dashes", "Sound like a friend, not a brand"],
    };
    const { rules } = assembleVoicePrompt(profile, "email");
    const byText = Object.fromEntries(rules.map((r) => [r.text, r.enforcement.kind]));
    expect(byText["Never use em dashes"]).toBe("forbids");
    expect(byText["Sound like a friend, not a brand"]).toBe("unenforced");
  });
});

/**
 * ─── Sample selection ─────────────────────────────────────────────────
 *
 * All 84 samples in the corpus are `channel:instagram`, so for `email`, `sms`,
 * `ad` and `product_page` the fallback is not an edge case — it is the only
 * path. Generation falls back to the whole corpus rather than refusing, per the
 * decision on #27: email copy written from the Instagram corpus has been working
 * in practice, so scoped samples are an improvement and not a prerequisite.
 *
 * What is not allowed is for the fallback to be invisible. A prompt built from
 * 84 email samples and a prompt built from 84 Instagram samples because there
 * were no email ones are different states that must not return the same value.
 */
describe("selectSamples: scoped, with a fallback that names itself", () => {
  it("returns only the channel's samples when it has some", () => {
    const sel = selectSamples(MIXED_PROFILE.samples, "instagram");
    expect(sel.source).toEqual({ kind: "channel", channel: "instagram" });
    expect(sel.samples.map((s) => s.id)).toEqual(["ig1", "ig2"]);
    expect(sel.corpusSize).toBe(4);
  });

  it("falls back to the whole corpus when a channel has no samples, and says so", () => {
    const sel = selectSamples(MIXED_PROFILE.samples, "sms");
    expect(sel.source).toEqual({ kind: "corpus-fallback", channel: "sms" });
    expect(sel.samples).toHaveLength(4);
  });

  // Distinct from the fallback above: nobody named a channel, so no filter could
  // have applied. Collapsing the two would make "we have no email samples" and
  // "nobody said which channel" report identically.
  it("distinguishes an unspecified audience from an empty channel", () => {
    const sel = selectSamples(MIXED_PROFILE.samples, UNSPECIFIED);
    expect(sel.source).toEqual({ kind: "whole-corpus-unspecified" });
    expect(sel.samples).toHaveLength(4);
  });

  it("does not select an untagged sample for a specific channel", () => {
    const sel = selectSamples(MIXED_PROFILE.samples, "email");
    expect(sel.samples.map((s) => s.id)).toEqual(["em1"]);
  });

  it("returns an empty selection rather than inventing one when the corpus is empty", () => {
    const sel = selectSamples([], "email");
    expect(sel.samples).toEqual([]);
    expect(sel.corpusSize).toBe(0);
    expect(sel.source).toEqual({ kind: "corpus-fallback", channel: "email" });
  });

  it("refuses an audience it does not recognise", () => {
    expect(() => selectSamples(MIXED_PROFILE.samples, "insta" as never)).toThrow(/audience/i);
  });
});

/**
 * "The source has to survive the return." A loader that logs its own fallback
 * and hands back a bare value has told the wrong person — the line an operator
 * reads is printed by the caller, so the caller needs a sentence it cannot
 * print without the source in it.
 */
describe("describeSampleSelection: an operator can tell the three states apart", () => {
  const described = (audience: Channel | typeof UNSPECIFIED) =>
    describeSampleSelection(selectSamples(MIXED_PROFILE.samples, audience));

  it("names the channel when the samples are the channel's own", () => {
    expect(described("instagram")).toMatch(/2 of 4/);
    expect(described("instagram")).toMatch(/instagram/);
  });

  it("says the corpus was substituted, and for which channel", () => {
    const d = described("sms");
    expect(d).toMatch(/sms/);
    expect(d).toMatch(/no samples|fell back|fallback/i);
  });

  it("gives the three states three different sentences", () => {
    const all = [described("instagram"), described("sms"), described(UNSPECIFIED)];
    expect(new Set(all).size).toBe(3);
  });
});

describe("assembleVoicePrompt: samples in the prompt follow the selection", () => {
  it("puts only the channel's samples into an instagram prompt", () => {
    const { systemPrompt, samples } = assembleVoicePrompt(MIXED_PROFILE, "instagram");
    expect(systemPrompt).toContain("copy ig1");
    expect(systemPrompt).not.toContain("copy em1");
    expect(samples.source.kind).toBe("channel");
  });

  it("generates from the whole corpus rather than refusing when a channel has none", () => {
    const { systemPrompt, samples } = assembleVoicePrompt(MIXED_PROFILE, "sms");
    expect(systemPrompt).toContain("copy ig1");
    expect(samples.source).toEqual({ kind: "corpus-fallback", channel: "sms" });
  });
});
