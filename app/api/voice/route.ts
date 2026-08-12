/**
 * Voice profile API — serves the full voice profile as JSON.
 * Used by the Figma plugin to fetch samples, rules, and banned words.
 *
 * GET /api/voice — returns the full profile
 * POST /api/voice/samples — add a new sample
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAllSamples, getAllRules, getAllBannedWords, addSample } from "@/domain/voice/queries";

export async function GET() {
  try {
    const d = db();
    const [samples, rules, bannedWords] = await Promise.all([
      getAllSamples(d),
      getAllRules(d),
      getAllBannedWords(d),
    ]);

    return NextResponse.json({
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
    return NextResponse.json(
      { error: "Voice profile not available" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, content, tags } = body;

    if (!title || !content) {
      return NextResponse.json(
        { error: "title and content are required" },
        { status: 400 }
      );
    }

    const sample = await addSample(db(), title, content, tags ?? []);
    return NextResponse.json(sample, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Failed to add sample" },
      { status: 500 }
    );
  }
}
