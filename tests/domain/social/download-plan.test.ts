import { describe, it, expect } from "vitest";
import { planDownloads, readDownloadLimits, eligibleAfterFailures, type DownloadCandidate } from "@/domain/social/download-plan";

const NOW = new Date("2026-11-12T12:00:00Z");
const c = (postId: string, account: DownloadCandidate["account"]): DownloadCandidate => ({ postId, account, username: account === "own" ? null : "x", permalink: `https://instagram.com/reel/${postId}/`, postedAt: NOW });
const limits = { plan: 100, teacher: 2, peer: 1 };
const none = { own: 0, teacher: 0, peer: 0 };
const noQuota = { remaining: null, resetAt: null };

describe("planDownloads", () => {
  it("does Tara's reels first, then teachers', then peers'", () => {
    const r = planDownloads({ own: [c("o1", "own")], teachers: [c("t1", "teacher")], peers: [c("p1", "peer")], usage: none, limits, quota: noQuota, now: NOW });
    expect(r.planned.map((p) => p.postId)).toEqual(["o1", "t1", "p1"]);
  });

  // Tara's are never capped; the plan's own limit still applies to everything.
  it("caps teachers and peers per month but never Tara", () => {
    const own = Array.from({ length: 5 }, (_, i) => c(`o${i}`, "own"));
    const r = planDownloads({ own, teachers: [c("t1", "teacher"), c("t2", "teacher"), c("t3", "teacher")], peers: [c("p1", "peer"), c("p2", "peer")], usage: { own: 0, teacher: 1, peer: 0 }, limits, quota: noQuota, now: NOW });
    expect(r.planned.filter((p) => p.account === "own")).toHaveLength(5);
    expect(r.planned.filter((p) => p.account === "teacher").map((p) => p.postId)).toEqual(["t1"]);
    expect(r.planned.filter((p) => p.account === "peer").map((p) => p.postId)).toEqual(["p1"]);
    // Left for next month, not dropped: they stay in the queue.
    expect(r.deferred).toEqual({ own: 0, teacher: 2, peer: 1 });
  });

  it("stops at the plan's monthly limit, whoever the reels are for", () => {
    const r = planDownloads({ own: [c("o1", "own"), c("o2", "own")], teachers: [c("t1", "teacher")], peers: [], usage: { own: 1, teacher: 0, peer: 0 }, limits: { ...limits, plan: 2 }, quota: noQuota, now: NOW });
    expect(r.planned.map((p) => p.postId)).toEqual(["o1"]);
    expect(r.deferred).toEqual({ own: 1, teacher: 1, peer: 0 });
  });

  it("calls nothing once the plan's limit is used", () => {
    const r = planDownloads({ own: [c("o1", "own")], teachers: [], peers: [], usage: { own: 3, teacher: 0, peer: 0 }, limits: { ...limits, plan: 3 }, quota: noQuota, now: NOW });
    expect(r).toMatchObject({ planned: [], blocked: "plan-limit" });
  });

  // The API's own count is the truth: calls made outside this system count too.
  it("trusts the quota the API last reported over its own count", () => {
    const r = planDownloads({ own: [c("o1", "own"), c("o2", "own")], teachers: [], peers: [], usage: none, limits, quota: { remaining: 1, resetAt: new Date("2026-12-12T00:00:00Z") }, now: NOW });
    expect(r.planned.map((p) => p.postId)).toEqual(["o1"]);
  });

  it("calls nothing while the API says the quota is spent", () => {
    const r = planDownloads({ own: [c("o1", "own")], teachers: [], peers: [], usage: none, limits, quota: { remaining: 0, resetAt: new Date("2026-12-12T00:00:00Z") }, now: NOW });
    expect(r).toMatchObject({ planned: [], blocked: "quota-exhausted" });
  });

  it("ignores a spent quota once its reset has passed", () => {
    const r = planDownloads({ own: [c("o1", "own")], teachers: [], peers: [], usage: none, limits, quota: { remaining: 0, resetAt: new Date("2026-11-01T00:00:00Z") }, now: NOW });
    expect(r.planned).toHaveLength(1);
  });

  it("takes at most the number asked for", () => {
    const r = planDownloads({ own: [c("o1", "own"), c("o2", "own")], teachers: [], peers: [], usage: none, limits, quota: noQuota, now: NOW, max: 1 });
    expect(r.planned.map((p) => p.postId)).toEqual(["o1"]);
  });
});

describe("eligibleAfterFailures", () => {
  it("drops a reel that has failed three times", () => {
    const failures = new Map([["o1", 3], ["o2", 2]]);
    expect(eligibleAfterFailures([c("o1", "own"), c("o2", "own"), c("o3", "own")], failures).map((p) => p.postId)).toEqual(["o2", "o3"]);
  });
});

describe("readDownloadLimits", () => {
  it("defaults to the free plan's 3 calls, 60 for teachers and 40 for peers", () => {
    expect(readDownloadLimits({})).toEqual({ plan: 3, teacher: 60, peer: 40 });
  });

  it("reads the settings, and falls back on anything that is not a whole number", () => {
    expect(readDownloadLimits({ RAPIDAPI_MONTHLY_LIMIT: "1000", TEACHER_MONTHLY_CAP: "80", PEER_MONTHLY_CAP: "lots" })).toEqual({ plan: 1000, teacher: 80, peer: 40 });
  });
});
