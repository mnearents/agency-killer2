import { describe, it, expect } from "vitest";
import { matchAssets, rollUp, normaliseAdName, type AdAsset } from "@/domain/meta/ad-assets";

const asset = (over: Partial<AdAsset>): AdAsset => ({
  id: "a1", source: "arcads", concept: "Teacher testimonial", hookText: "I stopped buying planners", body: null, format: "ugc",
  metaAdName: null, metaAdId: null, finishedAdDropboxId: null, notes: null, author: "claude", requestedBy: "Matt",
  createdAt: new Date("2026-11-01"), updatedAt: new Date("2026-11-01"), ...over,
});

describe("normaliseAdName", () => {
  it("ignores case, surrounding space and runs of spaces", () => {
    expect(normaliseAdName("  Teacher  UGC - V2 ")).toBe("teacher ugc - v2");
  });
});

describe("matchAssets", () => {
  // The ad ID is exact; a name is what people actually know.
  it("matches by ad id first, then by name", () => {
    const byId = asset({ id: "x", metaAdId: "ad_1", metaAdName: "Something else" });
    const byName = asset({ id: "y", metaAdName: "Teacher UGC v2" });
    const m = matchAssets([{ adId: "ad_1", adName: "Old name" }, { adId: "ad_2", adName: "teacher ugc  v2" }], [byId, byName]);
    expect(m.get("ad_1")?.id).toBe("x");
    expect(m.get("ad_2")?.id).toBe("y");
  });

  // Two ads can share a name; one asset can run as many ads.
  it("lets one asset cover several ads of the same name", () => {
    const m = matchAssets([{ adId: "ad_1", adName: "Hook A" }, { adId: "ad_2", adName: "Hook A" }], [asset({ metaAdName: "Hook A" })]);
    expect(m.size).toBe(2);
  });

  it("leaves an unregistered ad unmatched", () => {
    expect(matchAssets([{ adId: "ad_9", adName: "Mystery" }], [asset({ metaAdName: "Hook A" })]).size).toBe(0);
  });
});

describe("rollUp", () => {
  const rows = [
    { adId: "1", key: "arcads", spendCents: 10_000, purchases: 4, purchaseValueCents: 30_000 },
    { adId: "2", key: "arcads", spendCents: 10_000, purchases: 1, purchaseValueCents: 5_000 },
    { adId: "3", key: "footage_cut", spendCents: 5_000, purchases: 2, purchaseValueCents: 20_000 },
    { adId: "4", key: null, spendCents: 7_000, purchases: 0, purchaseValueCents: 0 },
  ];

  it("totals spend, purchases and revenue per key, with ROAS and CPA", () => {
    expect(rollUp(rows)).toEqual([
      { key: "arcads", ads: 2, spendDollars: 200, purchases: 5, revenueDollars: 350, roas: 1.75, cpaDollars: 40 },
      { key: "footage_cut", ads: 1, spendDollars: 50, purchases: 2, revenueDollars: 200, roas: 4, cpaDollars: 25 },
      { key: "(unregistered)", ads: 1, spendDollars: 70, purchases: 0, revenueDollars: 0, roas: 0, cpaDollars: null },
    ]);
  });
});
