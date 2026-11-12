import { describe, it, expect } from "vitest";
import { describeDownloadRun } from "@/domain/social/download-report";
import { fakeDb } from "../../mocks/recording-db";

const run = {
  calls: 2, ok: 1, failed: 1, stopped: null, deferred: { own: 0, teacher: 3, peer: 0 },
  results: [
    { postId: "t1", account: "teacher" as const, username: "lana.k.social", permalink: "https://instagram.com/reel/t1/", outcome: "ok", detail: null, transcribed: true },
    { postId: "o1", account: "own" as const, username: null, permalink: "https://instagram.com/reel/o1/", outcome: "no-video", detail: "message: Media not found" },
  ],
};

describe("describeDownloadRun", () => {
  it("shows what a teacher's reel showed, said and taught, and why a reel failed", async () => {
    const { db } = fakeDb({
      social_post_visuals: [{ postId: "t1", summary: "Lana talks to camera.", visualHook: "Your hook is too slow", faceInFirst2s: 1, cutsPerMinute: 18, durationMs: 31_000, audio: "speech" }],
      social_peer_posts: [{ id: "t1", transcript: "Stop opening with hi. Lead with the payoff.", openingWords: "Stop opening with hi." }],
      social_lessons: [{ postId: "t1", area: "hook", kind: "practice", principle: "Open with the payoff.", quote: "Lead with the payoff" }],
    });
    const text = (await describeDownloadRun(db, run, { transcriptChars: 20 })).join("\n");
    expect(text).toMatch(/2 download call\(s\): 1 analysed, 1 failed — still queued: Tara 0, teachers 3, peers 0/);
    expect(text).toMatch(/face in first 2s: yes · 18 cuts\/min · 31s · sound: speech/);
    expect(text).toMatch(/First words: "Stop opening with hi."/);
    expect(text).toMatch(/Transcript: Stop opening with hi…/);
    expect(text).toMatch(/• \[hook, practice\] Open with the payoff. — "Lead with the payoff"/);
    expect(text).toMatch(/no-video: message: Media not found/);
  });
});
