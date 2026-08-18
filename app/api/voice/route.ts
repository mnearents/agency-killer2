/**
 * Voice profile API — serves the full voice profile as JSON.
 * Used by the Figma plugin to fetch samples, rules, and banned words.
 *
 * GET /api/voice — returns the full profile
 * POST /api/voice — add a new sample
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAllSamples, getAllRules, getAllBannedWords, addSample } from "@/domain/voice/queries";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function jsonResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders });
}

export async function GET() {
  try {
    const d = db();
    const [samples, rules, bannedWords] = await Promise.all([
      getAllSamples(d),
      getAllRules(d),
      getAllBannedWords(d),
    ]);

    return jsonResponse({
      samples: samples.map((s) => ({
        id: s.id,
        title: s.title,
        content: s.content,
        tags: s.tags,
        createdAt: s.createdAt,
      })),
      rules: rules.map((r) => r.rule),
      bannedWords: bannedWords.map((b) => b.word),
    });
  } catch {
    return jsonResponse({ error: "Voice profile not available" }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, content, tags } = body;

    if (!title || !content) {
      return jsonResponse({ error: "title and content are required" }, 400);
    }

    const sample = await addSample(db(), title, content, tags ?? []);
    return jsonResponse(sample, 201);
  } catch {
    return jsonResponse({ error: "Failed to add sample" }, 500);
  }
}
