import { describe, it, expect } from "vitest";
import { loadVoiceProfileFromSeedFile } from "@/domain/voice/loader";
import { validateVoiceProfile } from "@/domain/voice/voice";

describe("loadVoiceProfileFromSeedFile", () => {
  it("loads the seed file with real samples", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.samples.length).toBeGreaterThan(0);
  });

  it("loads at least 30 writing samples", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.samples.length).toBeGreaterThanOrEqual(30);
  });

  it("every sample has non-empty content", () => {
    const profile = loadVoiceProfileFromSeedFile();
    for (const sample of profile.samples) {
      expect(sample.content.length).toBeGreaterThan(0);
      expect(sample.id).toBeDefined();
    }
  });

  it("loads brand rules", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.rules.length).toBeGreaterThan(0);
    expect(profile.rules).toContain("Never use em dashes");
  });

  it("loads banned words", () => {
    const profile = loadVoiceProfileFromSeedFile();
    expect(profile.bannedWords.length).toBeGreaterThan(0);
    expect(profile.bannedWords).toContain("synergy");
  });

  it("produces a valid voice profile", () => {
    const profile = loadVoiceProfileFromSeedFile();
    const validation = validateVoiceProfile(profile);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});
