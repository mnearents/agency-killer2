/**
 * Fail-closed check of generated copy against the voice rules for a channel.
 *
 * This is the enforcement half of `rules.ts`. Before it existed,
 * `assembleVoicePrompt` handed the guardrail only `bannedWords`; the rules were
 * injected into the prompt as prose and checked by nothing, so the rules list
 * read like a gate and behaved like a suggestion.
 *
 * ## What "fail closed" means here
 *
 * Three things that a permissive implementation reports as a pass, and this one
 * does not:
 *
 * - **Unparseable or empty text.** Nothing was checked, so nothing is clean.
 * - **An unknown channel.** Scope lookup on a typo matches no channel-scoped
 *   rule, and the natural result is an empty violation list — a clean pass over
 *   a rule set that was never assembled. This is the exact shape of #54 and it
 *   is rejected explicitly rather than relied on to fall out correctly. A caller
 *   that genuinely does not know its channel passes `UNSPECIFIED`, which applies
 *   every rule; it does not get to guess at one.
 * - **A profile with nothing to check.** Zero rules and zero banned words means
 *   the check did no work, which is not the same as the copy being fine.
 *
 * ## ok is not the whole result
 *
 * `ok: true` over three uncheckable rules and `ok: true` over three checked ones
 * are different states, so `enforced` and `unenforced` are part of the return
 * value and not a log line. A caller that prints only the verdict is reporting
 * less than it knows.
 */

import { isRuleAudience, rulesForChannel, type RuleAudience } from "./rules";
import type { VoiceProfile } from "./voice";

/**
 * A discouraged word that appeared. Never affects `ok`.
 *
 * Tara would rather not see these, but finished copy is not worth discarding
 * over one — see #60. They are surfaced so the copy can be reworded.
 */
export interface VoiceAdvisory {
  word: string;
  detail: string;
}

export interface VoiceViolation {
  /** The rule text, or a sentinel like `unknown-channel` for structural failures. */
  rule: string;
  detail: string;
}

export interface VoiceCheckResult {
  ok: boolean;
  /**
   * The audience the check ran for, or null when it was not recognised.
   * `UNSPECIFIED` is a recognised audience and means every rule was applied.
   */
  channel: RuleAudience | null;
  violations: VoiceViolation[];
  /** Discouraged words that appeared. Advisory only — `ok` ignores these. */
  advisories: VoiceAdvisory[];
  /** Rules that applied to this channel and were actually evaluated. */
  enforced: string[];
  /** Rules that applied but that nothing mechanically checks. */
  unenforced: string[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function voiceCheck(
  text: unknown,
  channel: unknown,
  profile: VoiceProfile
): VoiceCheckResult {
  const empty = { channel: null, enforced: [], unenforced: [], advisories: [] };

  // `UNSPECIFIED` passes here and resolves to every rule. A *typo* does not:
  // "unspecifed" and "insta" are still refused, because an audience nobody
  // meant to name selects a rule set nobody meant to apply.
  if (!isRuleAudience(channel)) {
    return {
      ...empty,
      ok: false,
      violations: [
        {
          rule: "unknown-channel",
          detail:
            `"${String(channel)}" is not a channel, so no rule set could be assembled. ` +
            "Refusing rather than reporting a clean check over zero rules.",
        },
      ],
    };
  }

  if (typeof text !== "string" || text.trim() === "") {
    return {
      ...empty,
      channel,
      ok: false,
      violations: [
        {
          rule: "empty-output",
          detail: "Text is empty, whitespace-only, or not a string — nothing was checked.",
        },
      ],
    };
  }

  const applicable = rulesForChannel(profile.rules, channel);
  const enforced: string[] = [];
  const unenforced: string[] = [];
  const violations: VoiceViolation[] = [];

  for (const rule of applicable) {
    if (rule.enforcement.kind === "unenforced") {
      unenforced.push(rule.text);
      continue;
    }
    enforced.push(rule.text);
    if (rule.enforcement.pattern.test(text)) {
      violations.push({
        rule: rule.text,
        detail: `Text matches ${rule.enforcement.pattern} on channel "${channel}".`,
      });
    }
  }

  const matches = (word: string) => new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);

  for (const word of profile.bannedWords) {
    if (matches(word)) {
      violations.push({
        rule: "banned-word",
        detail: `Text contains the banned word "${word}".`,
      });
    }
  }

  // Advisory. Deliberately not pushed into `violations`, because `ok` is what
  // decides whether a draft is saved and a preference must not decide that.
  const advisories: VoiceAdvisory[] = [];
  const discouraged = profile.discouragedWords ?? [];
  for (const word of discouraged) {
    if (matches(word)) {
      advisories.push({
        word,
        detail: `Contains "${word}", which Tara would rather avoid. Not a blocker — reword if there is a natural alternative.`,
      });
    }
  }

  // A check that evaluated nothing has established nothing. Reporting it as a
  // pass makes an unconfigured profile indistinguishable from clean copy.
  // A profile carrying only advisories has evaluated something, but nothing
  // that could ever fail — which is not a check in the sense `ok: true` implies.
  if (enforced.length === 0 && profile.bannedWords.length === 0) {
    return {
      channel,
      ok: false,
      enforced,
      unenforced,
      advisories,
      violations: [
        ...violations,
        {
          rule: "nothing-checked",
          detail:
            `No enforceable rule and no banned word applied on channel "${channel}", ` +
            `so this text was not checked${unenforced.length > 0 ? ` (${unenforced.length} applicable rule(s) are unenforced)` : ""}.`,
        },
      ],
    };
  }

  return { channel, ok: violations.length === 0, violations, advisories, enforced, unenforced };
}
