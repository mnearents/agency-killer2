import { describe, it, expect } from "vitest";
import { isGiveaway, buildPeerBaselines, scorePeerPost, summarisePeer, peerReelsForUpload, teacherReelsForUpload, type PeerPost } from "@/domain/social/peers";

const NOW = new Date("2026-11-09T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

let n = 0;
const post = (o: Partial<PeerPost> = {}): PeerPost => ({
  id: `p${++n}`, username: "pippipost.shop", caption: "New bookish totes", format: "image", permalink: null, thumbnailUrl: null,
  postedAt: daysAgo(10), likeCount: 1000, commentsCount: 20, viewCount: null, analysis: null, ...o,
});
const reel = (views: number, o: Partial<PeerPost> = {}) => post({ format: "reel", viewCount: views, ...o });

describe("isGiveaway", () => {
  it.each([
    "GIVEAWAY! Comment your favourite book to enter",
    "Comment BOOK to win this bundle",
    "We're picking a winner Friday",
  ])("spots %s", (c) => expect(isGiveaway(c)).toBe(true));

  it("leaves an ordinary caption alone", () => {
    expect(isGiveaway("Our cosiest reading socks are back")).toBe(false);
    expect(isGiveaway(null)).toBe(false);
  });
});

describe("buildPeerBaselines", () => {
  it("takes a reel's usual from views and anything else's from likes plus comments", () => {
    const b = buildPeerBaselines([reel(100), reel(200), reel(300), post({ likeCount: 90, commentsCount: 10 })], NOW);
    expect(b.get("pippipost.shop:reel")).toEqual({ measure: "views", median: 200, n: 3 });
    expect(b.get("pippipost.shop:image")).toEqual({ measure: "engagement", median: 100, n: 1 });
  });

  // "Comment to win" fills the comments with entries, not with interest.
  it("keeps giveaways out of the usual", () => {
    const b = buildPeerBaselines([post({ likeCount: 100, commentsCount: 0 }), post({ caption: "Comment to win!", likeCount: 100, commentsCount: 5000 })], NOW);
    expect(b.get("pippipost.shop:image")!.n).toBe(1);
  });

  it("keeps posts still settling out of the usual", () => {
    const b = buildPeerBaselines([post(), post({ postedAt: daysAgo(1) })], NOW);
    expect(b.get("pippipost.shop:image")!.n).toBe(1);
  });
});

describe("scorePeerPost", () => {
  const b = buildPeerBaselines(Array.from({ length: 6 }, () => reel(10_000)), NOW);

  it("calls a reel at four times the account's usual views a breakout", () => {
    expect(scorePeerPost(reel(40_015), b, NOW)).toMatchObject({ vsUsual: 4, verdict: "breakout", judgedOn: "views", giveaway: false });
  });

  it("names a giveaway as one", () => {
    expect(scorePeerPost(reel(40_015, { caption: "GIVEAWAY time" }), b, NOW).giveaway).toBe(true);
  });

  it("does not judge a post still settling, or one with too little history", () => {
    expect(scorePeerPost(reel(100, { postedAt: daysAgo(1) }), b, NOW).verdict).toBe("settling");
    expect(scorePeerPost(post(), b, NOW).verdict).toBe("not-enough-history");
  });

  // A reel without a view count is unmeasured — Instagram withheld it.
  it("calls a reel with no view count not measured", () => {
    expect(scorePeerPost(reel(0, { viewCount: null }), b, NOW).verdict).toBe("not-measured");
  });
});

describe("summarisePeer", () => {
  const posts = [
    ...Array.from({ length: 6 }, (_, i) => reel(10_000, { postedAt: daysAgo(12 + i) })),
    reel(40_015, { id: "hit", postedAt: daysAgo(4), analysis: { hookType: "question", approach: "entertain", topic: "reading", audience: "book lovers", hook: "Which book ruined you?" } }),
    post({ postedAt: daysAgo(3) }),
  ];
  const days = [
    { day: "2026-11-02", name: "Pippi Post", followersCount: 249_900, mediaCount: 2540 },
    { day: "2026-11-08", name: "Pippi Post", followersCount: 250_599, mediaCount: 2544 },
  ];

  it("gives the account's followers, its week's posts and its standouts", () => {
    const s = summarisePeer("pippipost.shop", posts, days, "2026-11-02", "2026-11-08", NOW);
    expect(s.followers).toEqual({ latest: 250_599, latestOn: "2026-11-08", changeInWeek: 699 });
    expect(s.postsInWeek.map((p) => p.id)).toEqual(["hit", expect.any(String)]);
    expect(s.standouts[0]).toMatchObject({ id: "hit", verdict: "breakout", hookType: "question", hook: "Which book ruined you?" });
  });

  it("counts how often it posts each format", () => {
    const s = summarisePeer("pippipost.shop", posts, days, "2026-11-02", "2026-11-08", NOW);
    expect(s.postsPerWeekLast30Days).toMatchObject({ reel: 1.6, image: 0.2 });
  });

  // Follower counts are read from the first sync on; one reading is no change.
  it("reports no weekly change from a single follower reading", () => {
    const s = summarisePeer("pippipost.shop", posts, [days[1]], "2026-11-02", "2026-11-08", NOW);
    expect(s.followers).toEqual({ latest: 250_599, latestOn: "2026-11-08", changeInWeek: null });
  });
});

describe("summarisePeer — an uploaded reel", () => {
  const visual = {
    basis: "frames", visualType: "person", visualHook: "POV: day 365", faceInFirst2s: true, productVisible: true, handDrawn: false,
    audio: "speech", cutsPerMinute: 24, summary: "A woman flips through a finished journal.", onScreenText: [], emotion: "proud", source: "manual_upload",
  };

  // What only the video shows — the opening face, the pace, the first words —
  // reaches the review once a copy is uploaded.
  it("carries what the video showed and the first words spoken", () => {
    const posts = [reel(40_015, { id: "up", postedAt: daysAgo(4), visual, openingWords: "I finished it." })];
    const s = summarisePeer("pippipost.shop", posts, [], "2026-11-02", "2026-11-08", NOW);
    expect(s.postsInWeek[0]).toMatchObject({
      openingWords: "I finished it.",
      visual: { looked: "frames", faceInFirst2s: true, cutsPerMinute: 24, audio: "speech", source: "manual_upload" },
    });
  });
});

describe("peerReelsForUpload", () => {
  const usual = Array.from({ length: 6 }, (_, i) => reel(10_000, { postedAt: daysAgo(12 + i) }));

  // The reels worth uploading are the ones that did unusually well for them.
  it("puts the reels furthest above their account's usual first", () => {
    const r = peerReelsForUpload([...usual, reel(20_000, { id: "twice" }), reel(50_000, { id: "breakout" }), post({ id: "img" })], NOW);
    expect(r.waiting.slice(0, 2).map((p) => [p.id, p.vsUsual])).toEqual([["breakout", 5], ["twice", 2]]);
    expect(r.waiting.some((p) => p.id === "img")).toBe(false);
  });

  it("puts reels it cannot judge after the ones it can, biggest first", () => {
    const r = peerReelsForUpload([...usual, reel(900, { id: "new", postedAt: daysAgo(1) }), reel(5_000, { id: "newer", postedAt: daysAgo(1) })], NOW);
    expect(r.waiting.slice(-2).map((p) => p.id)).toEqual(["newer", "new"]);
  });

  it("moves a reel already uploaded out of the waiting list", () => {
    const r = peerReelsForUpload([...usual, reel(50_000, { id: "done", visual: { basis: "frames", visualType: null, visualHook: null, faceInFirst2s: null, productVisible: null, handDrawn: null, audio: null, cutsPerMinute: null, source: "manual_upload" } })], NOW);
    expect(r.waiting.some((p) => p.id === "done")).toBe(false);
    expect(r.uploaded.map((p) => p.id)).toEqual(["done"]);
  });
});

describe("teacher reels", () => {
  const visualDone = { basis: "frames", visualType: null, visualHook: null, faceInFirst2s: null, productVisible: null, handDrawn: null, audio: null, cutsPerMinute: null, source: "manual_upload" };

  // A teacher's reel is worth uploading for what it says, not for how it did.
  it("keeps teachers' reels out of the peer list", () => {
    const r = peerReelsForUpload([reel(50_000, { id: "t", username: "lana.k.social", purpose: "teacher" }), reel(50_000, { id: "p" })], NOW);
    expect(r.waiting.map((p) => p.id)).toEqual(["p"]);
  });

  it("lists a teacher's reels newest first, whatever their age, and the ones already uploaded apart", () => {
    const t = (id: string, days: number, o: Partial<PeerPost> = {}) => reel(1000, { id, username: "lana.k.social", purpose: "teacher", postedAt: daysAgo(days), ...o });
    const r = teacherReelsForUpload([t("old", 200), t("new", 2), t("done", 5, { visual: visualDone }), post({ id: "img", username: "lana.k.social", purpose: "teacher" }), reel(1, { id: "peer" })]);
    expect(r.waiting.map((p) => p.id)).toEqual(["new", "old"]);
    expect(r.uploaded.map((p) => p.id)).toEqual(["done"]);
  });
});
