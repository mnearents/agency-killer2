/**
 * Rules are scoped per channel, and every rule declares whether anything
 * enforces it.
 *
 * Two separate failures motivate this module.
 *
 * **Scope.** `Don't say "comments get"` was applied to every channel, while five
 * of Tara's own captions (IG2, IG6, IG8, IG19, IG32) say exactly that. A
 * comment-to-DM CTA is correct on Instagram and nonsense in an inbox, so a
 * global ban is wrong in one direction and a global allowance is wrong in the
 * other. The rule needs a scope, not a rewording.
 *
 * **Enforcement.** `assembleVoicePrompt` put the rules into the prompt as prose
 * and passed only `bannedWords` to the guardrail. All three rules were enforced
 * by nothing — a list that reads like a gate and is a wish. A rule with no
 * checker is allowed here, but it has to say so out loud, because the dangerous
 * state is the one that looks enforced and isn't.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  CHANNELS,
  UNSPECIFIED,
  isChannel,
  isRuleAudience,
  rulesForChannel,
  RULE_REGISTRY,
  type RuleAudience,
} from "@/domain/voice/rules";

const seed = JSON.parse(
  readFileSync("src/domain/voice/voice-profile-seed.json", "utf8")
) as { rules: string[] };

const textsFor = (rules: string[], audience: RuleAudience) =>
  rulesForChannel(rules, audience).map((r) => r.text);

describe("isChannel", () => {
  it("accepts every channel the corpus can be tagged with", () => {
    for (const c of CHANNELS) expect(isChannel(c)).toBe(true);
  });

  // A typo'd channel that reads as valid selects the wrong rule set, and the
  // output looks fine because some rules still applied.
  it("rejects anything else, including near-misses", () => {
    for (const bad of ["insta", "Instagram", "e-mail", "", "channel:instagram"]) {
      expect(isChannel(bad), bad).toBe(false);
    }
  });
});

describe("rulesForChannel", () => {
  const COMMENTS = 'Don\'t say "comments get" as if you\'re writing an instagram post.';

  it("applies a global rule to every channel", () => {
    for (const c of CHANNELS) {
      expect(textsFor(["Never use em dashes"], c), c).toContain("Never use em dashes");
    }
  });

  // The whole point of the layer. This is correct Instagram copy.
  it("does not apply the comments-get rule on instagram", () => {
    expect(textsFor(seed.rules, "instagram")).not.toContain(COMMENTS);
  });

  it("applies the comments-get rule everywhere else", () => {
    for (const c of CHANNELS.filter((c) => c !== "instagram")) {
      expect(textsFor(seed.rules, c), c).toContain(COMMENTS);
    }
  });

  // Scope is expressed as "except in", so a channel nobody thought about
  // inherits every prohibition. An "applies to" list would hand a new channel
  // an empty rule set and call it compliant.
  it("gives a newly added channel every rule rather than none", () => {
    const rule = "Never use em dashes";
    for (const c of CHANNELS) expect(textsFor([rule], c), c).toContain(rule);
    expect(RULE_REGISTRY[rule].exceptIn).toEqual([]);
  });

  // A rule typed into the /voice dashboard has no registry entry. It must still
  // be applied, and must be reported as unenforced rather than quietly dropped.
  it("keeps a rule it has never seen before, on every channel", () => {
    const novel = "Always mention the free shipping threshold";
    for (const c of CHANNELS) expect(textsFor([novel], c), c).toContain(novel);
  });

  it("marks an unregistered rule as unenforced rather than pretending to check it", () => {
    const got = rulesForChannel(["Always mention the free shipping threshold"], "email");
    expect(got[0].enforcement.kind).toBe("unenforced");
  });

  it("carries a pattern for the rules it can actually enforce", () => {
    const got = rulesForChannel(["Never use em dashes"], "email");
    expect(got[0].enforcement.kind).toBe("forbids");
  });
});

/**
 * A caller that has not said what it is writing gets every rule, including the
 * ones some channel is excused from.
 *
 * The first version of `/api/generate` defaulted a missing channel to
 * `instagram`, which applied Instagram's *exclusions* — so the Figma plugin,
 * which Matt uses mainly for email, would have been told "link in bio" and
 * comment-to-DM CTAs were fine. That is precisely the leakage the scoping exists
 * to stop, shipped as a default.
 *
 * `unspecified` is not a channel. It is the absence of one, and it resolves to
 * the strictest possible rule set rather than a convenient guess.
 */
describe("rulesForChannel with an unspecified audience", () => {
  const COMMENTS = 'Don\'t say "comments get" as if you\'re writing an instagram post.';

  it("applies every rule, including ones a channel would be excused from", () => {
    const got = textsFor(seed.rules, UNSPECIFIED);
    for (const rule of seed.rules) expect(got, rule).toContain(rule);
  });

  it("applies scoped rules that instagram is excused from", () => {
    expect(textsFor(seed.rules, UNSPECIFIED)).toContain(COMMENTS);
    expect(textsFor(seed.rules, "instagram")).not.toContain(COMMENTS);
  });

  // It must not be usable as a corpus tag or a real channel.
  it("is not a channel", () => {
    expect(isChannel(UNSPECIFIED)).toBe(false);
    expect(CHANNELS).not.toContain(UNSPECIFIED as never);
  });

  it("is accepted as an audience, while a typo still is not", () => {
    expect(isRuleAudience(UNSPECIFIED)).toBe(true);
    expect(isRuleAudience("instagram")).toBe(true);
    for (const bad of ["insta", "unspecifed", "", "none"]) {
      expect(isRuleAudience(bad), bad).toBe(false);
    }
  });
});

/**
 * The registry is keyed by exact rule text, so an edit to the wording in the
 * seed file silently downgrades that rule to unenforced. That is the one way
 * this design can fail quietly, so it gets its own test.
 */
describe("rule registry coverage", () => {
  it("has an entry for every rule in the seed file", () => {
    for (const rule of seed.rules) {
      expect(
        RULE_REGISTRY[rule],
        `"${rule}" has no registry entry, so nothing enforces it and nothing says so. ` +
          `If the wording changed, update the key in src/domain/voice/rules.ts.`
      ).toBeDefined();
    }
  });

  it("scopes every registry entry to channels that exist", () => {
    for (const [text, scope] of Object.entries(RULE_REGISTRY)) {
      for (const c of scope.exceptIn) {
        expect(CHANNELS, `"${text}" is scoped to unknown channel "${c}"`).toContain(c);
      }
    }
  });
});
