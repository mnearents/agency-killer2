/**
 * Voice generation API — compatible with the Figma plugin.
 *
 * POST /api/generate
 * Body: { prompt: string }
 * Headers: Authorization: Bearer <VOICE_API_KEY>
 * Returns: { generatedText, samplesUsed, model, violations?, warning? }
 *
 * Loads voice profile from DB, assembles the prompt with samples +
 * rules + banned words, calls Claude, checks for banned word violations.
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { loadVoiceProfileWithDb } from "@/domain/voice/loader";
import { assembleVoicePrompt } from "@/domain/voice/voice";
import Anthropic from "@anthropic-ai/sdk";

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
    return NextResponse.json(
      { error: "Missing or invalid API key" },
      { status: 401 }
    );
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured" },
      { status: 500 }
    );
  }

  let body: { prompt?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const prompt = body.prompt?.trim();
  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
  }

  try {
    // Load voice profile from DB
    const d = db();
    const profile = await loadVoiceProfileWithDb(d);

    if (profile.samples.length === 0) {
      return NextResponse.json(
        { error: "No writing samples available. Add samples at /voice." },
        { status: 400 }
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

    // Check for banned word violations
    const violations: string[] = [];
    if (profile.bannedWords.length > 0) {
      const lowerText = generatedText.toLowerCase();
      for (const word of profile.bannedWords) {
        const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        if (regex.test(lowerText)) {
          violations.push(word);
        }
      }
    }

    return NextResponse.json({
      generatedText,
      samplesUsed: profile.samples.length,
      model: "claude-sonnet-4-5-20250929",
      violations: violations.length > 0 ? violations : undefined,
      warning: violations.length > 0
        ? `Generated text contains banned words/phrases: ${violations.join(", ")}`
        : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/generate] Error:", msg);
    return NextResponse.json(
      { error: "Failed to generate text", details: msg },
      { status: 500 }
    );
  }
}
