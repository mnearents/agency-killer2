/**
 * AI-writing avoidance rules — extended banned words list and prompt
 * instructions to prevent blog articles from sounding AI-generated.
 *
 * Based on https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 *
 * These extend the voice module's banned words (brand-specific) with
 * generic AI-sounding patterns that hurt SEO and brand credibility.
 */

/**
 * Words and phrases that signal AI-generated content. These are added
 * to the guardrails banned-words list for blog generation, on top of
 * the voice profile's brand-specific banned words.
 */
export const AI_WRITING_BANNED_WORDS: string[] = [
  // Overused "sophisticated" verbs
  "delve",
  "leverage",
  "foster",
  "unlock",
  "unleash",
  "empower",
  "elevate",
  "revolutionize",

  // Overused adjectives
  "multifaceted",
  "comprehensive",
  "intricate",
  "pivotal",
  "nuanced",
  "robust",
  "holistic",
  "dynamic",
  "innovative",
  "cutting-edge",
  "seamless",
  "crucial",

  // Overused nouns
  "tapestry",
  "landscape",
  "synergy",
  "paradigm",
  "realm",
  "game-changer",

  // Overused transitions
  "moreover",
  "furthermore",
  "additionally",
  "notably",

  // Overused hedging phrases
  "it's important to note",
  "it's worth noting",
  "it is important to note",
  "it is worth noting",
];

/**
 * Prompt instructions for avoiding AI-writing patterns in blog content.
 * Injected into the system prompt alongside the voice profile.
 */
export const AI_WRITING_AVOIDANCE_INSTRUCTIONS = `
## AI Writing Avoidance

Your blog articles must read like a human wrote them. Actively avoid these patterns:

1. **No filler transitions.** Don't start paragraphs with "Moreover," "Furthermore," "Additionally," or "In conclusion." Use natural connectives or just start the next thought.

2. **No hedging phrases.** Don't write "It's important to note that..." or "It's worth noting that..." — just state the thing.

3. **No inflated vocabulary.** Use simple, specific words over impressive-sounding ones. "Helps" not "empowers." "Changes" not "revolutionizes." "Useful" not "pivotal."

4. **No generic superlatives.** Don't call things "comprehensive," "innovative," "cutting-edge," or "game-changing" unless you're explaining specifically why.

5. **No abstract metaphors.** Don't describe things as a "tapestry," "landscape," "realm," or "paradigm." Be concrete.

6. **Write like you talk.** Short sentences mixed with longer ones. Contractions. Questions. Sentence fragments when they work. The way Tara's writing samples sound.

7. **Specific over generic.** Instead of "our comprehensive collection," name the actual products. Instead of "elevate your routine," describe the specific benefit.
`.trim();

/**
 * Merge AI-writing banned words with the voice profile's banned words,
 * deduplicating.
 */
export function mergeAiWritingBannedWords(
  voiceBannedWords: string[]
): string[] {
  const combined = new Set([
    ...voiceBannedWords.map((w) => w.toLowerCase()),
    ...AI_WRITING_BANNED_WORDS.map((w) => w.toLowerCase()),
  ]);
  return [...combined];
}
