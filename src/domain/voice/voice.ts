/**
 * Voice module — assembles Tara's brand voice into system prompts and
 * guardrail options. Deterministic: same inputs always produce the same prompt.
 *
 * ## The prompt is scoped to an audience, because the check always was
 *
 * `voiceCheck` has been scoped per channel since #59. This module was not, and
 * the asymmetry ran in the harmful direction. Generating an Instagram caption,
 * the prompt listed every rule including the two that are `exceptIn:
 * ["instagram"]` — "don't say comments get", "don't say link in bio outside
 * instagram" — so the model was told to avoid a convention that appears in five
 * of Tara's own captions, then graded by a checker that correctly excused it.
 * Steered by one rule set, checked by another; the copy gets worse on exactly
 * the channel the convention belongs to.
 *
 * So `assembleVoicePrompt` takes a `RuleAudience` and there is no default. A
 * caller that genuinely does not know its channel passes `UNSPECIFIED`, which is
 * excused from nothing. It does not get to omit the argument — see #61, where a
 * guessed default applied Instagram's *exclusions* to email.
 */

import type { GuardrailOptions } from "@/ai/guardrails";
import {
  channelOfSample,
  isRuleAudience,
  rulesForChannel,
  UNSPECIFIED,
  type Channel,
  type RuleAudience,
  type ScopedRule,
} from "./rules";

export interface WritingSample {
  id: string;
  title: string;
  content: string;
  tags: string[];
}

export interface VoiceProfile {
  samples: WritingSample[];
  rules: string[];
  bannedWords: string[];
  promptTemplate?: string;
}

/**
 * Where the few-shot examples in a prompt came from.
 *
 * A discriminated union rather than a count plus a boolean, because the three
 * states need different responses and one of them is not a problem at all:
 *
 * - `channel` — the samples are the channel's own. Nothing to say.
 * - `corpus-fallback` — a channel was named and *no sample carries its tag*, so
 *   the whole corpus stood in. All 84 samples are `channel:instagram`, so this
 *   is the normal path for email, sms, ad and product_page, not an edge case.
 *   Generation continues rather than refusing (#27: email copy written from the
 *   Instagram corpus has been working in practice) — but a prompt built from 84
 *   email samples and one built from 84 Instagram samples *because there were no
 *   email ones* are different states, and they must not return the same value.
 * - `whole-corpus-unspecified` — nobody named a channel, so no filter could have
 *   applied. Collapsing this into `corpus-fallback` would make "we have no email
 *   samples" indistinguishable from "nobody said which channel".
 */
export type SampleSource =
  | { kind: "channel"; channel: Channel }
  | { kind: "corpus-fallback"; channel: Channel }
  | { kind: "whole-corpus-unspecified" };

export interface SampleSelection {
  source: SampleSource;
  samples: WritingSample[];
  /** Everything available, selected or not, so a subset is never read as the whole. */
  corpusSize: number;
}

export interface VoicePromptResult {
  systemPrompt: string;
  guardrailOptions: GuardrailOptions;
  /** The audience this prompt was built for. */
  audience: RuleAudience;
  /**
   * The rules that went into the prompt, scoped to `audience` and each carrying
   * how it is enforced. Exposed rather than only rendered, so a caller can
   * report what the model was actually told — and so the sync between what is
   * prompted and what `voiceCheck` grades is assertable.
   */
  rules: ScopedRule[];
  samples: SampleSelection;
}

const DEFAULT_TEMPLATE = `You are a voice and tone generator for the Rad & Happy brand. Study the following writing examples carefully — match their voice, tone, word choice, sentence structure, and style. Use ONLY vocabulary and phrasing patterns found in the examples.

## Writing Examples

{{SAMPLES}}

## Rules

{{RULES}}

## Banned Words — NEVER use these words or phrases

{{BANNED_WORDS}}`;

function assertAudience(audience: unknown): asserts audience is RuleAudience {
  if (!isRuleAudience(audience)) {
    throw new Error(
      `"${String(audience)}" is not a valid audience. Pass a channel, or UNSPECIFIED ` +
        `when the channel is genuinely unknown — an audience nobody meant to name ` +
        `selects a rule set and a sample set nobody meant to apply.`
    );
  }
}

/**
 * The few-shot examples to use for `audience`, and where they came from.
 *
 * Throws on an unrecognised audience for the same reason `assembleVoicePrompt`
 * does: a typo would otherwise match no `channel:` tag, fall through to the
 * corpus, and produce a prompt that looks correctly scoped and is not.
 */
export function selectSamples(
  samples: readonly WritingSample[],
  audience: RuleAudience
): SampleSelection {
  assertAudience(audience);
  const corpusSize = samples.length;

  if (audience === UNSPECIFIED) {
    return {
      source: { kind: "whole-corpus-unspecified" },
      samples: [...samples],
      corpusSize,
    };
  }

  const forChannel = samples.filter((s) => channelOfSample(s.tags) === audience);

  if (forChannel.length === 0) {
    return {
      source: { kind: "corpus-fallback", channel: audience },
      samples: [...samples],
      corpusSize,
    };
  }

  return { source: { kind: "channel", channel: audience }, samples: forChannel, corpusSize };
}

/**
 * One sentence an operator can read, with the source in it.
 *
 * The caller is what prints the line a human sees, so handing back a bare count
 * and logging the fallback here would tell the wrong person. This exists so a
 * caller cannot print the count *without* the source — the shape of #54.
 */
export function describeSampleSelection(selection: SampleSelection): string {
  const { source, samples, corpusSize } = selection;
  const n = `${samples.length} of ${corpusSize} samples`;

  switch (source.kind) {
    case "channel":
      return `${n}, tagged channel:${source.channel}`;
    case "corpus-fallback":
      return `${n} — the whole corpus, because no sample is tagged channel:${source.channel} (fell back rather than generating from nothing)`;
    case "whole-corpus-unspecified":
      return `${n} — the whole corpus, because no channel was specified`;
  }
}

/**
 * Assemble a system prompt from the voice profile for a given audience. The
 * prompt includes the audience's writing samples as few-shot examples, the rules
 * that apply to that audience, and banned words as explicit prohibitions.
 *
 * `audience` is mandatory and validated at runtime, not just in the type system:
 * types are erased, and this is reachable from an API route.
 */
export function assembleVoicePrompt(
  profile: VoiceProfile,
  audience: RuleAudience
): VoicePromptResult {
  assertAudience(audience);

  const template = profile.promptTemplate ?? DEFAULT_TEMPLATE;
  const selection = selectSamples(profile.samples, audience);
  const rules = rulesForChannel(profile.rules, audience);

  const samplesBlock = selection.samples
    .map((s, i) => `Example ${i + 1}:\n${s.content}`)
    .join("\n\n");

  const rulesBlock =
    rules.length > 0 ? rules.map((r) => `- ${r.text}`).join("\n") : "No additional rules.";

  const bannedBlock =
    profile.bannedWords.length > 0
      ? profile.bannedWords.join(", ")
      : "None specified.";

  const systemPrompt = template
    .replace("{{SAMPLES}}", samplesBlock)
    .replace("{{RULES}}", rulesBlock)
    .replace("{{BANNED_WORDS}}", bannedBlock);

  const guardrailOptions: GuardrailOptions = {
    bannedWords: profile.bannedWords,
    checkPii: true,
    checkFabricatedStats: true,
  };

  return { systemPrompt, guardrailOptions, audience, rules, samples: selection };
}

/**
 * Validate that a voice profile has the minimum required data to produce
 * a useful prompt. Fails fast rather than generating a weak prompt.
 */
export function validateVoiceProfile(
  profile: VoiceProfile
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (profile.samples.length === 0) {
    errors.push("Profile must have at least one writing sample");
  }

  for (const sample of profile.samples) {
    if (!sample.content || sample.content.trim() === "") {
      errors.push(`Sample "${sample.id}" has empty content`);
    }
  }

  return { valid: errors.length === 0, errors };
}
