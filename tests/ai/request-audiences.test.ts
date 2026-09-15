/**
 * Every request builder in the system, and the audience each one names.
 *
 * `audience` is required on `OrchestratorRequest` precisely so that a generator
 * cannot reach the model without stating who its copy is for. That makes the
 * type system the call-site assertion — but only for builders that exist today.
 * A sixth generator added next month gets a compile error, picks whatever
 * audience makes it go green, and nothing here notices unless this list is the
 * place the choice is written down.
 *
 * So this file enumerates them. It is deliberately one test file rather than an
 * assertion buried in each builder's own suite: a missing entry here is visible,
 * a missing assertion in a file nobody opened is not.
 *
 * The rule for voice-driven generators is stronger than "names an audience" —
 * the audience must be the one the *prompt* was assembled for. Two independent
 * call sites that have to agree are two call sites that will eventually
 * disagree, which is the whole of #27's gap (a) restated. Deriving it from
 * `voice.audience` makes the agreement structural.
 */

import { describe, it, expect } from "vitest";
import { buildBlogRequest } from "@/domain/blog/prompt";
import { buildEmailCreativeRequest } from "@/domain/email/creative";
import { buildAnalysisRequest } from "@/domain/meta/analysis";
import { buildWeeklyReportRequest } from "@/domain/report/weekly-analysis";
import { buildSocialAnalysisRequest } from "@/domain/social/analysis";
import { assembleVoicePrompt, type VoiceProfile } from "@/domain/voice/voice";
import { CHANNELS, UNSPECIFIED, type RuleAudience } from "@/domain/voice/rules";
import type { OrchestratorRequest } from "@/ai/orchestrator";

const PROFILE: VoiceProfile = {
  samples: [
    { id: "ig1", title: "ig1", content: "ig copy", tags: ["channel:instagram", "intent:story"] },
  ],
  rules: ["Never use em dashes", 'Don\'t say "link in bio" outside instagram.'],
  bannedWords: ["synergy"],
};

const voiceFor = (a: RuleAudience) => assembleVoicePrompt(PROFILE, a);

/** Every builder, with the audience it is expected to name. */
const BUILDERS: Array<{
  name: string;
  expected: RuleAudience;
  /** Non-null when the audience has to match an assembled prompt's own. */
  build: (audience: RuleAudience) => OrchestratorRequest;
  derivesFromVoice: boolean;
}> = [
  {
    name: "buildEmailCreativeRequest",
    expected: "email",
    derivesFromVoice: true,
    build: (a) =>
      buildEmailCreativeRequest(
        {
          campaignName: "Summer Sale",
          goal: "drive orders",
          products: [{ title: "Planner", description: "A planner", priceCents: 2400 }],
        },
        voiceFor(a)
      ),
  },
  {
    name: "buildAnalysisRequest",
    expected: UNSPECIFIED,
    derivesFromVoice: true,
    build: (a) =>
      buildAnalysisRequest({
        campaigns: [],
        voice: voiceFor(a),
        outputType: "analysis",
      }),
  },
  {
    name: "buildWeeklyReportRequest",
    expected: UNSPECIFIED,
    derivesFromVoice: true,
    build: (a) => buildWeeklyReportRequest({ dataBlock: "## Ads\nSpend: $10", voice: voiceFor(a) }),
  },
  {
    name: "buildSocialAnalysisRequest",
    expected: UNSPECIFIED,
    derivesFromVoice: true,
    build: (a) =>
      buildSocialAnalysisRequest({
        topPosts: [],
        bottomPosts: [],
        breakdown: [],
        dateRange: { start: "2026-09-01", end: "2026-09-07" },
        followerCount: null,
        voice: voiceFor(a),
      }),
  },
  {
    /**
     * Blogs deliberately do NOT use Tara's voice — hers sounds forced in long
     * form — so this builder takes no assembled prompt and cannot derive an
     * audience from one. Not using her *tone* is not the same as being excused
     * from the brand's prohibitions: em dashes and vulgarity still apply, so it
     * names the audience excused from nothing.
     */
    name: "buildBlogRequest",
    expected: UNSPECIFIED,
    derivesFromVoice: false,
    build: () =>
      buildBlogRequest({
        topic: { title: "Ten ways to use a planner" },
        voiceBannedWords: PROFILE.bannedWords,
      }),
  },
];

describe("every orchestrator request names an audience", () => {
  it("covers every builder in the codebase", () => {
    // Guards against this list quietly emptying out or losing an entry.
    expect(BUILDERS.length).toBe(5);
  });

  it.each(BUILDERS)("$name names $expected", ({ expected, build }) => {
    expect(build(expected).audience).toBe(expected);
  });
});

/**
 * The prompt and the check have to be graded against the same rule set. Passing
 * the audience separately from the voice prompt makes that an agreement between
 * two call sites; deriving it from the prompt makes it an invariant.
 */
describe("a voice-driven request inherits the audience its prompt was built for", () => {
  const voiceDriven = BUILDERS.filter((b) => b.derivesFromVoice);

  it("has voice-driven builders to check", () => {
    expect(voiceDriven.length).toBeGreaterThan(0);
  });

  for (const { name, build } of voiceDriven) {
    it.each([...CHANNELS, UNSPECIFIED])(`${name} follows its prompt onto %s`, (audience) => {
      expect(build(audience).audience).toBe(audience);
    });
  }
});
