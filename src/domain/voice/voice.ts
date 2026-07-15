/**
 * Voice module — assembles Tara's brand voice into system prompts and
 * guardrail options. Deterministic: same inputs always produce the same prompt.
 */

import type { GuardrailOptions } from "@/ai/guardrails";

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

export interface VoicePromptResult {
  systemPrompt: string;
  guardrailOptions: GuardrailOptions;
}

const DEFAULT_TEMPLATE = `You are a voice and tone generator for the Rad & Happy brand. Study the following writing examples carefully — match their voice, tone, word choice, sentence structure, and style. Use ONLY vocabulary and phrasing patterns found in the examples.

## Writing Examples

{{SAMPLES}}

## Rules

{{RULES}}

## Banned Words — NEVER use these words or phrases

{{BANNED_WORDS}}`;

/**
 * Assemble a system prompt from the voice profile. The prompt includes all
 * writing samples as few-shot examples, brand rules as constraints, and
 * banned words as explicit prohibitions.
 */
export function assembleVoicePrompt(profile: VoiceProfile): VoicePromptResult {
  const template = profile.promptTemplate ?? DEFAULT_TEMPLATE;

  const samplesBlock = profile.samples
    .map((s, i) => `Example ${i + 1}:\n${s.content}`)
    .join("\n\n");

  const rulesBlock =
    profile.rules.length > 0
      ? profile.rules.map((r) => `- ${r}`).join("\n")
      : "No additional rules.";

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

  return { systemPrompt, guardrailOptions };
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
