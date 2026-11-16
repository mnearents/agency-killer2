import { describe, it, expect } from "vitest";
import { describeDownloadRun } from "@/domain/social/download-report";
import { fakeDb } from "../../mocks/recording-db";

const run = {
  calls: 2, ok: 1, failed: 1, stopped: null, only: null, queued: { own: 1, teacher: 0, peer: 4 }, deferred: { own: 0, teacher: 0, peer: 3 },
  results: [
    { postId: "t1", account: "peer" as const, username: "pippipost.shop", permalink: "https://instagram.com/reel/t1/", outcome: "ok", detail: null, transcribed: true },
    { postId: "o1", account: "own" as const, username: null, permalink: "https://instagram.com/reel/o1/", outcome: "no-video", detail: "message: Media not found" },
  ],
};

describe("describeDownloadRun", () => {
  it("shows what a competitor's reel showed and said, and why a reel failed", async () => {
    const { db } = fakeDb({
      social_post_visuals: [{ postId: "t1", summary: "She talks to camera.", visualHook: "Your hook is too slow", faceInFirst2s: 1, cutsPerMinute: 18, durationMs: 31_000, audio: "speech" }],
      social_peer_posts: [{ id: "t1", transcript: "Stop opening with hi. Lead with the payoff.", openingWords: "Stop opening with hi." }],
    });
    const text = (await describeDownloadRun(db, run, { transcriptChars: 20 })).join("\n");
    expect(text).toMatch(/Waiting: Tara 1, peers 4\. 2 download call\(s\): 1 analysed, 1 failed — still queued: Tara 0, peers 3/);
    expect(text).toMatch(/@pippipost\.shop \(peer\) — https:\/\/instagram\.com\/reel\/t1\//);
    expect(text).toMatch(/face in first 2s: yes · 18 cuts\/min · 31s · sound: speech/);
    expect(text).toMatch(/First words: "Stop opening with hi."/);
    expect(text).toMatch(/Transcript: Stop opening with hi…/);
    expect(text).toMatch(/no-video: message: Media not found/);
  });
});

// "0 calls" alone read as a run that failed to start; say the queue was empty.
it("says when nothing was waiting, and that no call was made", async () => {
  const { db } = fakeDb({});
  const lines = await describeDownloadRun(db, { calls: 0, ok: 0, failed: 0, stopped: null, only: "own", queued: { own: 0, teacher: 0, peer: 0 }, deferred: { own: 0, teacher: 0, peer: 0 }, results: [] }, { transcriptChars: 10 });
  expect(lines.join(" ")).toMatch(/Nothing to download: none of Tara's cover-only reels are waiting.*No RapidAPI call was made/);
});
