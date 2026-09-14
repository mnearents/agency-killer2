/**
 * Voice generation API — compatible with the Figma plugin.
 *
 * POST /api/generate
 * Body: { prompt: string, channel?: Channel }
 * Headers: Authorization: Bearer <VOICE_API_KEY>
 * Returns: { generatedText, samplesUsed, model, channel, rulesEnforced,
 *            rulesUnenforced?, violations?, warning? }
 *
 * Loads voice profile from DB, assembles the prompt with samples + rules +
 * banned words, calls Claude, then runs the output through `voiceCheck`.
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
import { assembleVoicePrompt } from "@/domain/voice/voice";
import { voiceCheck } from "@/domain/voice/voice-check";
import { isChannel, CHANNELS } from "@/domain/voice/rules";
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

  // The Figma plugin predates channels and sends none. Instagram is the only
  // channel the corpus has samples for, and it is the plugin's use case, so it
  // is the default — but a channel that was *sent* and is not recognised is an
  // error, not something to quietly fall back from. A typo'd "e-mail" silently
  // treated as instagram would skip every rule email exists to enforce.
  const channel = body.channel ?? "instagram";
  if (!isChannel(channel)) {
    return jsonResponse(
      { error: `Unknown channel "${channel}". Expected one of: ${CHANNELS.join(", ")}` },
      400
    );
  }

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

    // Assemble the voice prompt
    const voice = assembleVoicePrompt(profile);

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
      samplesUsed: profile.samples.length,
      model: "claude-sonnet-4-5-20250929",
      channel,
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
