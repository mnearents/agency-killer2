/**
 * Voice profile loader — loads from DB first, falls back to seed file.
 *
 * On first run with an empty DB, seeds the DB from the JSON file so
 * future edits go to the DB and persist across deploys.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { VoiceProfile, WritingSample } from "./voice";
import type { Db } from "@/db/client";
import { loadVoiceProfileFromDb, seedVoiceProfileToDb } from "./queries";

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

function loadSeedFile(): VoiceProfile {
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

  return {
    samples: seed.samples.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.content,
      tags: s.tags,
    })),
    rules: seed.rules,
    bannedWords: seed.bannedWords,
    promptTemplate: seed.promptTemplate,
  };
}

/**
 * Load voice profile from the seed file only, ignoring the database.
 *
 * Named explicitly because it is almost never what a caller wants. Samples are
 * edited through the /voice dashboard, the API, and the `!voice add` Slack
 * command, and every one of those writes to the database — so anything that
 * generates copy from this function is working off a frozen snapshot and will
 * silently ignore every edit. Use `loadVoiceProfileWithDb` unless there is
 * genuinely no database available.
 */
export function loadVoiceProfileFromSeedFile(): VoiceProfile {
  return loadSeedFile();
}

/**
 * Load voice profile from DB, seeding from file if DB is empty.
 * Call this after DB is available for the most up-to-date profile.
 */
export async function loadVoiceProfileWithDb(db: Db): Promise<VoiceProfile> {
  const dbProfile = await loadVoiceProfileFromDb(db);

  if (dbProfile) {
    console.log(`[voice] Loaded from DB: ${dbProfile.samples.length} samples, ${dbProfile.rules.length} rules, ${dbProfile.bannedWords.length} banned words`);
    return dbProfile;
  }

  // DB is empty — seed from file
  const seedProfile = loadSeedFile();
  if (seedProfile.samples.length > 0) {
    try {
      const count = await seedVoiceProfileToDb(db, seedProfile);
      console.log(`[voice] Seeded DB with ${count} items from seed file`);
    } catch (err) {
      console.warn("[voice] Failed to seed DB:", err);
    }
  }

  return seedProfile;
}
