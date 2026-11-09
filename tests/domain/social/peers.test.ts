import { describe, it, expect } from "vitest";
import { isGiveaway, buildPeerBaselines, scorePeerPost, summarisePeer, type PeerPost } from "@/domain/social/peers";

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
