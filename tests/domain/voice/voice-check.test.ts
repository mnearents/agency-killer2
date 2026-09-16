/**
 * `voiceCheck` is the enforcement half of the voice rules. It fails closed.
 *
 * Before this existed, `assembleVoicePrompt` handed the guardrail only
 * `bannedWords`. "Never use em dashes", "No vulgarity" and the comments-get rule
 * were injected into the prompt as prose and checked by nothing, so the rules
 * list read like a gate and behaved like a suggestion.
 *
 * The two failure modes that matter here are both "passes when it should not":
 *
 * - An **unknown channel** must not resolve to an empty rule set. "No rules
 *   matched, therefore clean" is the exact shape that made #54 invisible.
 * - **Unenforced rules must be visible in the result.** `ok: true` with three
 *   rules nothing can check is not the same as `ok: true` with everything
 *   checked, and a caller that cannot tell them apart will read the first as the
 *   second.
 */

import { describe, it, expect } from "vitest";
import { voiceCheck } from "@/domain/voice/voice-check";
import { CHANNELS, UNSPECIFIED } from "@/domain/voice/rules";
import type { VoiceProfile } from "@/domain/voice/voice";

const profile = (over: Partial<VoiceProfile> = {}): VoiceProfile => ({
  samples: [],
  rules: [],
  bannedWords: [],
  discouragedWords: [],
  ...over,
});

const COMMENTS = 'Don\'t say "comments get" as if you\'re writing an instagram post.';

describe("voiceCheck fail-closed behaviour", () => {
  // An unchecked output is not a clean output.
  it.each([
    ["empty string", ""],
    ["whitespace only", "   \n\t "],
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { text: "hi" }],
  ])("blocks %s rather than passing it through", (_label, input) => {
    const r = voiceCheck(input, "email", profile({ rules: ["Never use em dashes"] }));
    expect(r.ok).toBe(false);
  });

  // The dangerous case: a typo'd channel matches no scoped rule, and a naive
  // implementation reports a clean pass over an empty rule set.
  it("blocks an unknown channel instead of finding nothing to complain about", () => {
    const r = voiceCheck("perfectly fine copy", "insta", profile({ bannedWords: ["synergy"] }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("unknown-channel");
  });

  it("names the channel it rejected, so the typo is findable", () => {
    const r = voiceCheck("copy", "e-mail", profile());
    expect(r.violations[0].detail).toContain("e-mail");
  });

  // A profile with no rules and no banned words checks nothing. Reporting that
  // as a pass is indistinguishable from a real one.
  it("does not report a clean pass when there was nothing to check", () => {
    const r = voiceCheck("anything at all", "email", profile());
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("nothing-checked");
  });
});

describe("voiceCheck rule enforcement", () => {
  it("catches an em dash", () => {
    const r = voiceCheck("Planners — they're here", "email", profile({ rules: ["Never use em dashes"] }));
    expect(r.ok).toBe(false);
    expect(r.violations[0].rule).toBe("Never use em dashes");
  });

  it("passes copy that obeys the rule", () => {
    const r = voiceCheck("Planners are here", "email", profile({ rules: ["Never use em dashes"] }));
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("catches vulgarity, including inflected forms", () => {
    for (const bad of ["this is shit", "shitty planner", "damn right", "pissed off"]) {
      const r = voiceCheck(bad, "email", profile({ rules: ["No vulgarity"] }));
      expect(r.ok, bad).toBe(false);
    }
  });

  // Tara's actual register. A vulgarity check that trips on these blocks correct
  // copy, and a guardrail that cries wolf gets switched off.
  it("leaves Tara's own emphatic words alone", () => {
    for (const fine of [
      "so dang happy",
      "freaking cutest ever",
      "whatever the heck this is",
      "drove my booty straight to the store",
      "that's a load of crap",
    ]) {
      const r = voiceCheck(fine, "instagram", profile({ rules: ["No vulgarity"] }));
      expect(r.ok, fine).toBe(true);
    }
  });

  it("catches a banned word regardless of case", () => {
    const r = voiceCheck("What a DELIGHT", "email", profile({ bannedWords: ["delight"] }));
    expect(r.ok).toBe(false);
    expect(r.violations[0].detail).toContain("delight");
  });

  it("does not trip a banned word inside a longer word", () => {
    const r = voiceCheck("delightful is a different word", "email", profile({ bannedWords: ["delight"] }));
    expect(r.ok).toBe(true);
  });
});

/**
 * These fixtures carry a global rule alongside the scoped one on purpose. With
 * only the scoped rule, an instagram check evaluates nothing, and `ok: true`
 * would mean "nothing ran" rather than "the scoped rule correctly did not fire".
 * The first draft of these tests made exactly that mistake and `nothing-checked`
 * caught it.
 */
describe("voiceCheck channel scoping", () => {
  const withGlobal = (scoped: string) => profile({ rules: [scoped, "Never use em dashes"] });

  it("allows a comment CTA on instagram, where it is correct copy", () => {
    const r = voiceCheck("All comments get a link!", "instagram", withGlobal(COMMENTS));
    expect(r.ok).toBe(true);
    expect(r.enforced).toEqual(["Never use em dashes"]);
  });

  it("blocks the same line in email, where there are no comments", () => {
    const r = voiceCheck("All comments get a link!", "email", profile({ rules: [COMMENTS] }));
    expect(r.ok).toBe(false);
  });

  // Five of Tara's captions say this. If the scoping regressed, the corpus
  // itself would fail its own check.
  it("passes the real captions that motivated the scope", () => {
    for (const line of [
      "All comments get a link to the all new Halloween advent calendar!",
      "Easily the best $5 you'll spend this month. All comments get a link!",
      "All comments get a link to the best sketchbooks and notebooks everrr.",
    ]) {
      const r = voiceCheck(line, "instagram", withGlobal(COMMENTS));
      expect(r.ok, line).toBe(true);
    }
  });

  it("blocks link-in-bio phrasing off instagram", () => {
    for (const c of ["email", "sms"]) {
      const r = voiceCheck("Link in bio!", c, profile({ rules: ["Don't say \"link in bio\" outside instagram."] }));
      expect(r.ok, c).toBe(false);
    }
  });

  it("allows link-in-bio phrasing on instagram", () => {
    const r = voiceCheck(
      "Sign up via link in my profile.",
      "instagram",
      withGlobal('Don\'t say "link in bio" outside instagram.')
    );
    expect(r.ok).toBe(true);
  });
});

/**
 * The Figma plugin is Matt's main copy tool and is used mostly for **email**. It
 * sends no channel. Defaulting that to instagram would have applied Instagram's
 * exclusions to email copy and permitted "link in bio" and comment CTAs in the
 * one context where they are wrong — the leakage this scoping exists to prevent,
 * shipped as a default.
 */
describe("voiceCheck with an unspecified channel", () => {
  const scoped = profile({
    rules: [COMMENTS, 'Don\'t say "link in bio" outside instagram.', "Never use em dashes"],
  });

  it("enforces rules instagram is excused from", () => {
    expect(voiceCheck("All comments get a link!", UNSPECIFIED, scoped).ok).toBe(false);
    expect(voiceCheck("Link in bio!", UNSPECIFIED, scoped).ok).toBe(false);
  });

  it("is stricter than any real channel, never more permissive", () => {
    const unspecified = voiceCheck("clean copy", UNSPECIFIED, scoped).enforced;
    for (const c of CHANNELS) {
      const forChannel = voiceCheck("clean copy", c, scoped).enforced;
      for (const rule of forChannel) expect(unspecified, `${c}: ${rule}`).toContain(rule);
    }
  });

  it("still passes copy that breaks nothing", () => {
    expect(voiceCheck("Planners are here and they are lovely", UNSPECIFIED, scoped).ok).toBe(true);
  });

  // "unspecified" is a deliberate absence. A typo is not.
  it("does not make the unknown-channel guard permissive", () => {
    expect(voiceCheck("copy", "unspecifed", scoped).ok).toBe(false);
    expect(voiceCheck("copy", "insta", scoped).ok).toBe(false);
  });
});

describe("voiceCheck reports what it could and could not check", () => {
  it("lists the rules it actually evaluated", () => {
    const r = voiceCheck("clean copy", "email", profile({ rules: ["Never use em dashes"] }));
    expect(r.enforced).toEqual(["Never use em dashes"]);
  });

  // The rule this module exists to stop being broken: a pass over rules nothing
  // checks must not read like a pass over rules that were checked.
  it("names an applicable rule that nothing enforces", () => {
    const r = voiceCheck("clean copy", "email", profile({
      rules: ["Never use em dashes", "Sound like a friend, not a brand"],
    }));
    expect(r.unenforced).toEqual(["Sound like a friend, not a brand"]);
    expect(r.enforced).toEqual(["Never use em dashes"]);
  });

  it("does not list a rule that does not apply to this channel as unenforced", () => {
    const r = voiceCheck("clean copy", "instagram", profile({ rules: [COMMENTS, "Never use em dashes"] }));
    expect(r.unenforced).toEqual([]);
    expect(r.enforced).toEqual(["Never use em dashes"]);
  });

  // ok must not be weakened into "ok as far as I bothered to look".
  it("still passes when some rules are unenforced, because blocking everything is not the answer", () => {
    const r = voiceCheck("clean copy", "email", profile({
      rules: ["Never use em dashes", "Sound like a friend, not a brand"],
    }));
    expect(r.ok).toBe(true);
    expect(r.unenforced.length).toBeGreaterThan(0);
  });

  it("reports every violation, not just the first", () => {
    const r = voiceCheck("This — is shit", "email", profile({
      rules: ["Never use em dashes", "No vulgarity"],
    }));
    expect(r.violations).toHaveLength(2);
  });
});

/**
 * ─── Discouraged words are not banned words (#60) ─────────────────────
 *
 * Every entry in the word list was treated as a hard block, so a draft
 * containing "delight" could not be saved at all. Tara's actual position:
 * *"Delight shouldn't be a hard ban, I just would rather not use that word.
 * But it shouldn't cause an entire response to fail."*
 *
 * That is a distinction the model did not have. The list conflates two things:
 *
 * - **block** — do not publish this. Nothing currently qualifies; the one
 *   genuinely unpublishable category, vulgarity, is a *rule* with its own
 *   regex, not a word-list entry.
 * - **avoid** — a preference. Worth flagging so it can be reworded, never
 *   worth discarding finished copy over.
 *
 * Every existing word is a style preference — synergy, delight, shenanigans,
 * alrighty, "let's do this", "these babies", brighter — so `avoid` is the
 * default and `block` has to be asked for.
 *
 * Advisories never touch `ok`. A guardrail that blocks correct copy gets
 * turned off, and this one was one word away from doing that.
 */
describe("voiceCheck: discouraged words advise, they do not block", () => {
  const withWords = (over: { bannedWords?: string[]; discouragedWords?: string[] }) =>
    profile({ rules: ["Never use em dashes"], bannedWords: [], discouragedWords: [], ...over });

  it("reports a discouraged word without failing the check", () => {
    const r = voiceCheck("What a delight this is", "email", withWords({ discouragedWords: ["delight"] }));
    expect(r.ok).toBe(true);
    expect(r.advisories.map((a) => a.word)).toEqual(["delight"]);
    expect(r.violations).toEqual([]);
  });

  it("still blocks a word marked as a hard block", () => {
    const r = voiceCheck("Pure synergy", "email", withWords({ bannedWords: ["synergy"] }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("banned-word");
  });

  it("keeps the two apart when both appear", () => {
    const r = voiceCheck(
      "Pure synergy and what a delight",
      "email",
      withWords({ bannedWords: ["synergy"], discouragedWords: ["delight"] })
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toEqual(["banned-word"]);
    expect(r.advisories.map((a) => a.word)).toEqual(["delight"]);
  });

  it("matches a discouraged word on a word boundary, like a banned one", () => {
    const p = withWords({ discouragedWords: ["delight"] });
    expect(voiceCheck("delightful is a different word", "email", p).advisories).toEqual([]);
    expect(voiceCheck("What a DELIGHT", "email", p).advisories).toHaveLength(1);
  });

  it("names the word so the copy can be reworded rather than rewritten", () => {
    const r = voiceCheck("what a delight", "email", withWords({ discouragedWords: ["delight"] }));
    expect(r.advisories[0].detail).toMatch(/delight/);
  });

  it("returns no advisories for clean copy", () => {
    expect(voiceCheck("Our planners are here", "email", withWords({ discouragedWords: ["delight"] })).advisories)
      .toEqual([]);
  });

  /**
   * A profile carrying only advisories has evaluated something, but nothing
   * that could ever fail — so it is not a check in the sense `ok: true` implies.
   */
  it("still refuses when nothing that could fail was evaluated", () => {
    const r = voiceCheck("anything", "email", profile({ rules: [], bannedWords: [], discouragedWords: [] }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("nothing-checked");
  });

  it("treats a profile with only discouraged words as having checked nothing blocking", () => {
    const r = voiceCheck("clean copy", "email", profile({ rules: [], bannedWords: [], discouragedWords: ["delight"] }));
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.rule)).toContain("nothing-checked");
  });
});
