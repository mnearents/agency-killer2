/**
 * Voice profile loader — reads the seed data file and builds a VoiceProfile.
 *
 * The seed file contains Tara's real writing samples, brand rules, and
 * banned words exported from the Figma plugin voice service.
 *
 * This is used at worker startup to initialize the voice profile.
 * Eventually samples will live in the KB (Postgres), but the seed file
 * ensures the voice works even before KB sync runs.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { VoiceProfile, WritingSample } from "./voice";

interface SeedData {
  samples: Array<{
    id: string;
    content: string;
    title: string;
    tags: string[];
    createdAt: string;
  }>;
  rules: string[];
  bannedWords: string[];
  promptTemplate?: string;
}

export function loadVoiceProfile(): VoiceProfile {
  // Try multiple paths since the working directory varies between dev and prod
  const paths = [
    join(dirname(fileURLToPath(import.meta.url)), "voice-profile-seed.json"),
    join(process.cwd(), "src/domain/voice/voice-profile-seed.json"),
  ];

  let raw: string | null = null;
  for (const path of paths) {
    try {
      raw = readFileSync(path, "utf-8");
      break;
    } catch {
      continue;
    }
  }

  if (!raw) {
    console.warn("[voice] Could not load voice-profile-seed.json — using empty profile");
    return {
      samples: [],
      rules: [],
      bannedWords: ["synergy", "delve", "leverage"],
    };
  }

  const seed: SeedData = JSON.parse(raw);

  const samples: WritingSample[] = seed.samples.map((s) => ({
    id: s.id,
    title: s.title,
    content: s.content,
    tags: s.tags,
  }));

  return {
    samples,
    rules: seed.rules,
    bannedWords: seed.bannedWords,
    promptTemplate: seed.promptTemplate,
  };
}
