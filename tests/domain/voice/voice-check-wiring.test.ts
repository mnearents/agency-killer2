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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../../../app/api/generate/route";

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

  // A rejected channel must not fall back to a default. Treating a typo as a
  // real channel skips every rule the intended one exists to enforce.
  it("rejects an unrecognised channel rather than defaulting past it", () => {
    expect(route).toMatch(/isChannel\s*\(/);
    const guard = route.match(/if\s*\([\s\S]{0,80}?!isChannel\([\s\S]{0,300}?\n  \}/);
    expect(guard, "no `!isChannel(...)` guard found").not.toBeNull();
    expect(guard![0]).toMatch(/400/);
  });

  /**
   * Matt uses this plugin mostly for EMAIL and it sends no channel. Defaulting
   * to instagram applies Instagram's *exclusions*, which would permit "link in
   * bio" and comment-to-DM CTAs in an inbox — the exact leakage the scoping
   * exists to stop.
   */
  it("does not default a missing channel to instagram", () => {
    const fallback = route.match(/requested\s*\?\?\s*([A-Za-z_"'.]+)/);
    expect(fallback, "no `requested ??` default found").not.toBeNull();
    expect(fallback![1]).not.toMatch(/instagram/);
  });

  it("falls back to the audience that applies every rule", () => {
    expect(route).toMatch(/requested\s*\?\?\s*UNSPECIFIED/);
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

/**
 * The assertions above read the source, which proves a guard is *written* and
 * not that it is *reached*. Wrapping the channel check in `if (false && ...)`
 * leaves every one of them green — a mutation that survived, which is the same
 * "looks enforced, isn't" shape this whole module exists to close.
 *
 * These call `POST` for real. The channel guard returns before `db()` or the
 * Anthropic client is touched, so no seam needs mocking: DATABASE_URL is
 * removed precisely so that reaching the body of the handler fails loudly
 * instead of connecting to something.
 */
const KEY = "test-voice-key";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    })
  );

describe("/api/generate channel handling, called for real", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VOICE_API_KEY = KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("rejects a typo'd channel with a 400 that names it", async () => {
    const res = await post({ prompt: "write a launch email", channel: "e-mail" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("e-mail");
  });

  it.each(["insta", "Instagram", "", "channel:instagram"])(
    "rejects %o rather than checking against a rule set nobody asked for",
    async (channel) => {
      expect((await post({ prompt: "write copy", channel })).status).toBe(400);
    }
  );

  // The Figma plugin's request, exactly: a prompt and no channel. It must get
  // past the guard rather than be rejected, and must not be quietly relabelled.
  it("accepts a request that sends no channel at all", async () => {
    const res = await post({ prompt: "write a launch email" });
    expect(res.status).not.toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/Unknown channel/);
  });

  it("accepts every real channel", async () => {
    for (const c of ["instagram", "email", "sms", "ad", "product_page"]) {
      const res = await post({ prompt: "write copy", channel: c });
      expect(res.status, c).not.toBe(400);
    }
  });
});
