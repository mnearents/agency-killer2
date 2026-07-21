import { describe, it, expect } from "vitest";
import { loadVoiceProfile } from "@/domain/voice/loader";
import { validateVoiceProfile } from "@/domain/voice/voice";

describe("loadVoiceProfile", () => {
  it("loads the seed file with real samples", () => {
    const profile = loadVoiceProfile();
    expect(profile.samples.length).toBeGreaterThan(0);
  });

  it("loads at least 30 writing samples", () => {
    const profile = loadVoiceProfile();
    expect(profile.samples.length).toBeGreaterThanOrEqual(30);
  });

  it("every sample has non-empty content", () => {
    const profile = loadVoiceProfile();
    for (const sample of profile.samples) {
      expect(sample.content.length).toBeGreaterThan(0);
      expect(sample.id).toBeDefined();
    }
  });

  it("loads brand rules", () => {
    const profile = loadVoiceProfile();
    expect(profile.rules.length).toBeGreaterThan(0);
    expect(profile.rules).toContain("Never use em dashes");
  });

  it("loads banned words", () => {
    const profile = loadVoiceProfile();
    expect(profile.bannedWords.length).toBeGreaterThan(0);
    expect(profile.bannedWords).toContain("synergy");
  });

  it("produces a valid voice profile", () => {
    const profile = loadVoiceProfile();
    const validation = validateVoiceProfile(profile);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});
