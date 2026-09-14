/**
 * `voiceCheck` wired to nothing is indistinguishable from a `voiceCheck` that
 * always passes.
 *
 * The rules it enforces were already written down before this module existed —
 * in the seed file, in the prompt, in the docstring on `assembleVoicePrompt`.
 * What was missing was any code that acted on them. Repeating that with a
 * better-tested module and still no caller would be the same failure with more
 * lines. See CLAUDE.md, "Assert the call site, not just the behavior".
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const route = readFileSync(join(process.cwd(), "app/api/generate/route.ts"), "utf-8");

describe("/api/generate voice check wiring", () => {
  it("checks the generated text before returning it", () => {
    expect(route).toMatch(/voiceCheck\s*\(/);
  });

  // The local loop this replaced enforced banned words and nothing else, so
  // "no violations" meant "no banned words" while reading as "passed the rules".
  it("no longer hand-rolls its own banned-word loop alongside the shared check", () => {
    expect(route).not.toMatch(/for\s*\(\s*const\s+word\s+of\s+profile\.bannedWords/);
  });

  it("checks the model's output, not the user's prompt", () => {
    expect(route).toMatch(/voiceCheck\s*\(\s*generatedText/);
  });

  // A rejected channel must not fall back to a default. Treating a typo as
  // instagram skips every rule the intended channel exists to enforce.
  it("rejects an unrecognised channel rather than defaulting past it", () => {
    expect(route).toMatch(/isChannel\s*\(/);
    const guard = route.match(/if\s*\(\s*!isChannel\([\s\S]{0,300}?\n  \}/);
    expect(guard, "no `if (!isChannel(...))` guard found").not.toBeNull();
    expect(guard![0]).toMatch(/400/);
  });

  // Without this the caller cannot tell a clean check from an empty one.
  it("reports which rules actually ran", () => {
    expect(route).toMatch(/rulesEnforced/);
    expect(route).toMatch(/check\.enforced/);
  });

  it("surfaces rules that nothing enforces instead of dropping them", () => {
    expect(route).toMatch(/check\.unenforced/);
  });
});
