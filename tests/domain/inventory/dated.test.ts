import { describe, it, expect } from "vitest";
import {
  datedEditionYear,
  daysUntilEditionEnds,
  computeDatedOverhang,
} from "@/domain/inventory/dated";
import type { InventoryItem } from "@/domain/inventory/checks";

/** 2026-09-08. 115 days remain before a 2026 edition stops being sellable. */
const NOW = new Date("2026-09-08T00:00:00Z");

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    variantId: "gid://shopify/ProductVariant/1",
    productTitle: "2026 Dated 5x8 Planner",
    variantTitle: "Default",
    sku: "PLNRD5X8Y26",
    quantity: 617,
    priceCents: 1000,
    tracked: true,
    productStatus: "ACTIVE",
    unitsSoldLast30d: 25,
    ...overrides,
  };
}

describe("datedEditionYear", () => {
  it("reads the year from a dated product title", () => {
    expect(datedEditionYear("2026 Dated 5x8 Planner")).toBe(2026);
    expect(datedEditionYear("2026 Wall Calendar")).toBe(2026);
  });

  it("is null for an undated product", () => {
    expect(datedEditionYear("8x10 Undated Education Planner - Pencil Edition")).toBeNull();
    expect(datedEditionYear("Rad Pack Strap Extender")).toBeNull();
  });

  // The SKU suffix convention was investigated and rejected: two conventions
  // coexist, the bare-year form usually means introduction rather than edition,
  // and a Y-prefix rule matches NOTEHAPPY01 and BLKBBY012021 by accident. The
  // title is the reliable signal, so nothing here may look at a SKU.
  it("does not read a year out of a SKU-style edition suffix", () => {
    expect(datedEditionYear("PLNRD5X8Y26")).toBeNull();
    expect(datedEditionYear("PLNRUD8X10Y23 Undated Planner")).toBeNull();
  });

  // Restricted to 20xx rather than any four digits. Nothing in the catalogue
  // carries a four-digit run that isn't a 20xx year today, so the restriction
  // costs no coverage and keeps a future part number from being read as a
  // deadline that strands stock on a report.
  it("ignores four-digit runs that are not plausible edition years", () => {
    expect(datedEditionYear("Model 1200 Fineliner")).toBeNull();
    expect(datedEditionYear("Ref 120267 Notebook")).toBeNull();
  });

  // Later year wins. The error this avoids is the expensive direction: reading
  // a 2026-2027 academic planner as expiring in 2026 declares a year of live
  // stock unsellable.
  it("takes the later year when a title spans two", () => {
    expect(datedEditionYear("2026-2027 Academic Planner")).toBe(2027);
  });
});

describe("daysUntilEditionEnds", () => {
  it("counts the days left before the edition's year is over", () => {
    expect(daysUntilEditionEnds(2026, NOW)).toBe(115);
  });

  it("looks a full year further ahead for next year's edition", () => {
    expect(daysUntilEditionEnds(2027, NOW)).toBe(480);
  });

  // Not a negative number. A lapsed edition has no life left, and a negative
  // multiplied through the stranding arithmetic invents sales that unwind
  // stock that is already worthless.
  it("is zero, not negative, once the edition's year has passed", () => {
    expect(daysUntilEditionEnds(2025, NOW)).toBe(0);
    expect(daysUntilEditionEnds(2024, NOW)).toBe(0);
  });
});

describe("computeDatedOverhang", () => {
  it("is null for an undated product, which has no deadline to measure against", () => {
    expect(
      computeDatedOverhang(item({ productTitle: "Undated 8x10 Planner" }), NOW)
    ).toBeNull();
  });

  // The distinction the whole module exists for. 617 units at 25/30 per day
  // sells about 96 over the 115 days left, leaving 521 on the shelf on
  // January 1st. A velocity ratio calls this 24 months of cover and healthy.
  it("strands the stock that will not sell before the deadline", () => {
    const overhang = computeDatedOverhang(item(), NOW)!;
    expect(overhang.editionYear).toBe(2026);
    expect(overhang.daysOfSellableLife).toBe(115);
    expect(overhang.unitsStranded).toBe(521);
    expect(overhang.centsStranded).toBe(521_000);
  });

  it("strands nothing when the edition will sell through in time", () => {
    const overhang = computeDatedOverhang(
      item({ quantity: 50, unitsSoldLast30d: 30 }),
      NOW
    )!;
    expect(overhang.unitsStranded).toBe(0);
    expect(overhang.centsStranded).toBe(0);
  });

  // Still reported rather than dropped: "dated and fine" and "not dated at
  // all" are different answers, and collapsing them hides the deadline from
  // whoever is deciding whether to discount.
  it("still reports the edition when nothing is stranded", () => {
    const overhang = computeDatedOverhang(
      item({ quantity: 50, unitsSoldLast30d: 30 }),
      NOW
    );
    expect(overhang).not.toBeNull();
    expect(overhang!.editionYear).toBe(2026);
  });

  // The worst case, and the one a velocity ratio cannot see at all: cover is
  // infinite, so every unit is stranded.
  it("strands the whole quantity when nothing is selling", () => {
    const overhang = computeDatedOverhang(item({ unitsSoldLast30d: 0 }), NOW)!;
    expect(overhang.unitsStranded).toBe(617);
  });

  it("strands the whole quantity once the edition's year has passed", () => {
    const overhang = computeDatedOverhang(
      item({ productTitle: "2025 Wall Calendar" }),
      NOW
    )!;
    expect(overhang.daysOfSellableLife).toBe(0);
    expect(overhang.unitsStranded).toBe(617);
  });

  // Untracked variants report quantity 0 in Shopify, and the digital "2026
  // Pages" packs read *negative*. Stranding arithmetic on a sentinel produces
  // a confident dollar figure for stock that does not exist.
  it("is null for an untracked variant, whose quantity is a sentinel", () => {
    expect(computeDatedOverhang(item({ tracked: false }), NOW)).toBeNull();
    expect(
      computeDatedOverhang(item({ tracked: false, quantity: -26 }), NOW)
    ).toBeNull();
  });

  it("strands nothing on an oversold variant rather than a negative count", () => {
    const overhang = computeDatedOverhang(item({ quantity: -5 }), NOW)!;
    expect(overhang.unitsStranded).toBe(0);
  });

  // DRAFT and UNLISTED dated stock is real and tracked — 2,449 units of it in
  // production as of 2026-09-08 — so the flag is computed for it. Whether the
  // reporting surface shows non-ACTIVE products is that surface's filter to
  // apply, not a reason to blind the calculation.
  it("still measures dated stock that is not yet listed", () => {
    const overhang = computeDatedOverhang(
      item({ productStatus: "DRAFT", productTitle: "2027 Dated 8x10 Planner" }),
      NOW
    );
    expect(overhang).not.toBeNull();
    expect(overhang!.editionYear).toBe(2027);
  });

  // The bug this file was written to prevent, found by running the finished
  // calculation against production: the two DRAFT 2027 planners came back as
  // 1,997 units and $50,919 certainly stranded. They are next year's stock. A
  // product nobody could buy during the sales window sold nothing BY
  // CONSTRUCTION, so zero is absence of evidence, not evidence of no demand,
  // and projecting it forward is a confident five-figure fiction.
  it("cannot project a product that was not on sale during the window", () => {
    const overhang = computeDatedOverhang(
      item({
        productStatus: "DRAFT",
        productTitle: "2027 Dated 8x10 Planner - Pencil Edition",
        quantity: 997,
        unitsSoldLast30d: 0,
      }),
      NOW
    )!;
    expect(overhang.editionYear).toBe(2027);
    expect(overhang.daysOfSellableLife).toBe(480);
    expect(overhang.unitsStranded).toBeNull();
    expect(overhang.centsStranded).toBeNull();
  });

  it("does not report an unlisted edition as having nothing stranded", () => {
    const overhang = computeDatedOverhang(
      item({ productStatus: "UNLISTED", unitsSoldLast30d: 0 }),
      NOW
    )!;
    expect(overhang.unitsStranded).not.toBe(0);
  });

  // Once the deadline has passed no demand estimate is needed: whatever is on
  // the shelf is stranded by arithmetic, listed or not.
  it("strands an expired edition outright, needing no sales history", () => {
    const overhang = computeDatedOverhang(
      item({
        productStatus: "ARCHIVED",
        productTitle: "2024 Wall Calendar",
        quantity: 6,
        unitsSoldLast30d: 0,
      }),
      NOW
    )!;
    expect(overhang.unitsStranded).toBe(6);
  });

  // Zero sales from a product that WAS on sale is real evidence, and the
  // strongest case of all — a velocity ratio reports infinite cover.
  it("strands the whole quantity when a listed edition is not selling", () => {
    const overhang = computeDatedOverhang(item({ unitsSoldLast30d: 0 }), NOW)!;
    expect(overhang.unitsStranded).toBe(617);
  });
});
