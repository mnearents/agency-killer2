/**
 * Voice generation API — compatible with the Figma plugin.
 *
 * POST /api/generate
 * Body: { prompt: string, channel?: Channel }
 * Headers: Authorization: Bearer <VOICE_API_KEY>
 * Returns: { generatedText, samplesUsed, corpusSize, sampleSource, model,
 *            channel, rulesPrompted, rulesEnforced, rulesUnenforced?,
 *            violations?, warning? }
 *
 * Loads voice profile from DB, assembles the prompt with the channel's samples +
 * the rules that apply to that channel + banned words, calls Claude, then runs
 * the output through `voiceCheck` for the same channel.
 *
 * `rulesPrompted` and `rulesEnforced ∪ rulesUnenforced` describe the same set,
 * and that is the point. They did not before #27's task 3: the check was scoped
 * per channel and the prompt was not, so an Instagram generation was told to
 * avoid "comments get" and "link in bio" — conventions that appear in five of
 * Tara's own captions — and then graded by a checker that correctly excused
 * both.
 *
 * `samplesUsed` is how many examples went into the prompt, not how many exist.
 * `sampleSource` says why those ones: the channel's own, or the whole corpus
 * standing in because no sample carries that channel's tag. All 84 samples are
 * `channel:instagram`, so the fallback is the normal path for the other four.
 *
 * `channel` is optional and defaults to `unspecified`, which is excused from no
 * rule. A channel that *is* sent and is not recognised is a 400 — see the guard
 * below for why those two absences are not the same thing.
 *
 * `rulesEnforced` is in the response deliberately. This endpoint used to check
 * banned words with a local regex loop and nothing else, so a response with no
 * violations meant "no banned words" while reading as "passed the voice rules".
 * Naming the rules that ran makes a clean result distinguishable from a check
 * that did very little.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadVoiceProfileWithDb } from "@/domain/voice/loader";
import { assembleVoicePrompt, describeSampleSelection } from "@/domain/voice/voice";
import { voiceCheck } from "@/domain/voice/voice-check";
import { isChannel, CHANNELS, UNSPECIFIED, type RuleAudience } from "@/domain/voice/rules";
import Anthropic from "@anthropic-ai/sdk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders });
}

function checkAuth(request: Request): boolean {
  const apiKey = process.env.VOICE_API_KEY;
  if (!apiKey) return false;

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;

  return authHeader.slice(7) === apiKey;
}

export async function POST(request: Request) {
  // Auth check
  if (!checkAuth(request)) {
    return jsonResponse(
      { error: "Missing or invalid API key" },
      401
    );
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return jsonResponse(
      { error: "ANTHROPIC_API_KEY not configured" },
      500
    );
  }

  let body: { prompt?: string; channel?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return jsonResponse({ error: "Prompt is required" }, 400);
  }

  // The Figma plugin predates channels and sends none. It is Matt's main copy
  // tool and he uses it mostly for EMAIL, so defaulting to instagram — which an
  // earlier version did — would have applied Instagram's *exclusions* to email
  // copy and permitted "link in bio" and comment-to-DM CTAs in an inbox. That is
  // the leakage the scoping exists to stop, shipped as a default.
  //
  // `UNSPECIFIED` is excused from nothing, so a caller that cannot say what it
  // is writing gets the strictest rule set rather than a convenient guess. A
  // channel that *was* sent and is not recognised stays an error: a typo'd
  // "e-mail" quietly widened to "check everything" would hide the typo.
  const requested = body.channel;
  if (requested !== undefined && !isChannel(requested)) {
    return jsonResponse(
      { error: `Unknown channel "${requested}". Expected one of: ${CHANNELS.join(", ")}` },
      400
    );
  }
  const channel: RuleAudience = requested ?? UNSPECIFIED;

  try {
    // Load voice profile from DB
    const d = db();
    const profile = await loadVoiceProfileWithDb(d);

    if (profile.samples.length === 0) {
      return jsonResponse(
        { error: "No writing samples available. Add samples at /voice." },
        400
      );
    }

    // The same `channel` the check uses. Before #27's task 3 this call took no
    // audience, so the model was told every rule — including the two Instagram
    // is excused from — and then graded against the scoped set. Steered by one
    // rule set, checked by another.
    const voice = assembleVoicePrompt(profile, channel);

    // Call Claude
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1024,
      system: voice.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    const generatedText = message.content[0].type === "text"
      ? message.content[0].text
      : "";

    // Checked through the shared guardrail rather than a local banned-word loop.
    // The loop this replaces enforced banned words only, so "never use em
    // dashes" and the rest were prompt text that nothing verified.
    const check = voiceCheck(generatedText, channel, profile);
    const violations = check.violations.map((v) => v.detail);

    return jsonResponse({
      generatedText,
      // How many examples actually went into the prompt, and why those ones.
      // This used to report the size of the whole corpus, which is the same
      // number whether the channel was filtered on or ignored.
      samplesUsed: voice.samples.samples.length,
      corpusSize: voice.samples.corpusSize,
      sampleSource: describeSampleSelection(voice.samples),
      model: "claude-sonnet-4-5-20250929",
      channel,
      // What the model was told. Alongside `rulesEnforced` this makes the
      // steer/grade asymmetry visible in the response rather than only in a
      // test: the two lists have to describe the same set.
      rulesPrompted: voice.rules.map((r) => r.text),
      // Which rules actually ran. A caller that sees no violations and no
      // enforced list cannot tell a clean check from one that did nothing.
      rulesEnforced: check.enforced,
      rulesUnenforced: check.unenforced.length > 0 ? check.unenforced : undefined,
      violations: violations.length > 0 ? violations : undefined,
      warning: violations.length > 0
        ? `Generated text failed the voice check for ${channel}: ${violations.join("; ")}`
        : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/generate] Error:", msg);
    return jsonResponse(
      { error: "Failed to generate text", details: msg },
      500
    );
  }
}
