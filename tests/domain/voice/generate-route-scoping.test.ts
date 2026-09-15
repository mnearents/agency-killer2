/**
 * The route's channel has to reach the *prompt*, not only the check.
 *
 * `voiceCheck` has been scoped per channel since #59 while `assembleVoicePrompt`
 * was not, so the model was steered by every rule and graded against the scoped
 * set. Asserting that from the route's source would repeat #61's mistake: those
 * wiring tests read `route.ts` as text, and wrapping the guard in
 * `if (false && ...)` left all eight green — they proved the guard was written,
 * not reached.
 *
 * So these call `POST` for real, with the database, the loader and the Anthropic
 * SDK replaced at their seams, and assert on the payload that comes back. A
 * channel that never reaches the assembly cannot change these numbers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { VoiceProfile } from "@/domain/voice/voice";

const IG_ONLY = 'Don\'t say "comments get" as if you\'re writing an instagram post.';
const BIO_ONLY = 'Don\'t say "link in bio" outside instagram.';

const PROFILE: VoiceProfile = {
  samples: [
    { id: "ig1", title: "ig1", content: "ig copy one", tags: ["channel:instagram", "intent:story"] },
    { id: "ig2", title: "ig2", content: "ig copy two", tags: ["channel:instagram", "intent:promo"] },
    { id: "em1", title: "em1", content: "email copy one", tags: ["channel:email", "intent:launch"] },
  ],
  rules: ["Never use em dashes", "No vulgarity", IG_ONLY, BIO_ONLY],
  bannedWords: ["synergy"],
};

vi.mock("@/lib/db", () => ({ db: () => ({}) }));
vi.mock("@/domain/voice/loader", () => ({
  loadVoiceProfileWithDb: async () => ({ ...PROFILE, source: "database" }),
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => ({ content: [{ type: "text", text: "a perfectly ordinary sentence" }] }),
    };
  },
}));

const { POST } = await import("../../../app/api/generate/route");

const KEY = "test-voice-key";

async function generate(body: unknown) {
  const res = await POST(
    new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("/api/generate: the channel reaches the prompt", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VOICE_API_KEY = KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.DATABASE_URL = "postgres://stub";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("generates at all, so the assertions below are not vacuous", async () => {
    const { status, body } = await generate({ prompt: "write copy", channel: "instagram" });
    expect(status).toBe(200);
    expect(body.generatedText).toBe("a perfectly ordinary sentence");
  });

  /**
   * The rule the whole task is about. On Instagram the two `exceptIn:
   * ["instagram"]` rules must not be in the prompt — telling the model to avoid
   * a convention that appears in five of Tara's own captions degrades exactly
   * the channel the convention belongs to.
   */
  it("does not prompt an instagram generation with the rules instagram is excused from", async () => {
    const { body } = await generate({ prompt: "write a caption", channel: "instagram" });
    expect(body.rulesPrompted).not.toContain(IG_ONLY);
    expect(body.rulesPrompted).not.toContain(BIO_ONLY);
    expect(body.rulesPrompted).toContain("Never use em dashes");
  });

  it("does prompt those rules on email", async () => {
    const { body } = await generate({ prompt: "write a launch email", channel: "email" });
    expect(body.rulesPrompted).toContain(IG_ONLY);
    expect(body.rulesPrompted).toContain(BIO_ONLY);
  });

  it("prompts every rule when no channel is sent", async () => {
    const { body } = await generate({ prompt: "write copy" });
    expect(body.rulesPrompted).toEqual(PROFILE.rules);
  });

  /**
   * Steered and graded by the same set, asserted end to end through the route
   * rather than over the module in isolation.
   */
  it.each(["instagram", "email", "sms", "ad", "product_page", undefined])(
    "prompts exactly the rules it grades against, on %s",
    async (channel) => {
      const { body } = await generate({ prompt: "write copy", ...(channel ? { channel } : {}) });
      const graded = [
        ...(body.rulesEnforced as string[]),
        ...((body.rulesUnenforced as string[]) ?? []),
      ].sort();
      expect((body.rulesPrompted as string[]).slice().sort()).toEqual(graded);
    }
  );
});

describe("/api/generate: which samples were used, and why those", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VOICE_API_KEY = KEY;
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.DATABASE_URL = "postgres://stub";
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("uses only the channel's samples when it has some", async () => {
    const { body } = await generate({ prompt: "write a caption", channel: "instagram" });
    expect(body.samplesUsed).toBe(2);
    expect(body.corpusSize).toBe(3);
    expect(body.sampleSource).toMatch(/channel:instagram/);
  });

  /**
   * All 84 real samples are `channel:instagram`, so this is the normal path for
   * four of the five channels. It must generate rather than refuse — and it must
   * not look like a channel that had its own samples. "3 samples" is the same
   * number either way; only the source tells them apart.
   */
  it("falls back to the whole corpus for a channel with no samples, and says so", async () => {
    const { status, body } = await generate({ prompt: "write a text", channel: "sms" });
    expect(status).toBe(200);
    expect(body.generatedText).toBeTruthy();
    expect(body.samplesUsed).toBe(3);
    expect(body.sampleSource).toMatch(/no sample is tagged channel:sms/);
  });

  it("gives the three sample sources three different descriptions", async () => {
    const sources = await Promise.all(
      [{ channel: "instagram" }, { channel: "sms" }, {}].map(async (c) =>
        (await generate({ prompt: "write copy", ...c })).body.sampleSource
      )
    );
    expect(new Set(sources).size).toBe(3);
  });
});
