import { describe, it, expect } from "vitest";
import {
  DHL_BPM_GROUND_2026,
  rateShipment,
  rateBand,
  type RateCard,
} from "@/domain/economics/postage-rates";

const CARD = DHL_BPM_GROUND_2026;

describe("DHL_BPM_GROUND_2026", () => {
  it("prices all eight zones", () => {
    expect(CARD.zones).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("gives every break a rate for every zone", () => {
    for (const b of CARD.breaks) {
      expect(b.zoneRatesCents, `break ${b.weightLb}lb`).toHaveLength(CARD.zones.length);
    }
  });

  it("has ascending weight breaks, which the lookup relies on", () => {
    const weights = CARD.breaks.map((b) => b.weightLb);
    expect([...weights].sort((a, b) => a - b)).toEqual(weights);
  });

  it("never gets cheaper as the zone gets further", () => {
    for (const b of CARD.breaks) {
      for (let i = 1; i < b.zoneRatesCents.length; i++) {
        expect(b.zoneRatesCents[i], `break ${b.weightLb}lb zone ${i + 1}`)
          .toBeGreaterThanOrEqual(b.zoneRatesCents[i - 1]);
      }
    }
  });

  it("never gets cheaper as the parcel gets heavier", () => {
    for (let i = 1; i < CARD.breaks.length; i++) {
      for (let z = 0; z < CARD.zones.length; z++) {
        expect(CARD.breaks[i].zoneRatesCents[z]).toBeGreaterThan(CARD.breaks[i - 1].zoneRatesCents[z]);
      }
    }
  });

  // The card prints fuel as a flat amount per break, and it is $0.30 per pound
  // of the break weight throughout. Asserted so a transcription slip in one row
  // is caught rather than quietly mispricing that weight.
  it("carries a fuel surcharge of $0.30 per pound of the break weight", () => {
    for (const b of CARD.breaks) {
      expect(b.fuelSurchargeCents, `break ${b.weightLb}lb`).toBe(Math.round(b.weightLb * 30));
    }
  });
});

describe("rateShipment", () => {
  it("prices a parcel that lands exactly on a break", () => {
    // 2.5 lb, zone 1: $7.08 + $0.75 fuel
    expect(rateShipment(CARD, 2.5, 1)).toEqual({ ok: true, cents: 783, breakWeightLb: 2.5, zone: 1 });
  });

  // Carriers round up to the next break. Rounding to nearest would underprice
  // every parcel just over a break, which is most of them.
  it("charges the next break up for a parcel between breaks", () => {
    const r = rateShipment(CARD, 2.35, 5);
    expect(r).toEqual({ ok: true, cents: 874, breakWeightLb: 2.5, zone: 5 });
  });

  it("does not round down to the nearer break", () => {
    // 2.1 lb is nearer 2 than 2.5, and is still charged at 2.5.
    const r = rateShipment(CARD, 2.1, 1);
    expect(r.ok && r.breakWeightLb).toBe(2.5);
  });

  it("prices the heaviest zone correctly", () => {
    // 1 lb, zone 8: $6.65 + $0.30
    expect(rateShipment(CARD, 1, 8)).toEqual({ ok: true, cents: 695, breakWeightLb: 1, zone: 8 });
  });

  it("prices a parcel below the lightest break at that break", () => {
    const r = rateShipment(CARD, 0.06, 1);
    expect(r.ok && r.breakWeightLb).toBe(1);
  });

  // An unrateable shipment must not collapse into the same value as a cheap
  // one — that is how a missing cost becomes a free shipment.
  it("refuses a parcel heavier than the card covers", () => {
    expect(rateShipment(CARD, 20, 1)).toEqual({ ok: false, reason: "over_max_weight" });
  });

  it("refuses a zone the card does not price", () => {
    expect(rateShipment(CARD, 2, 9)).toEqual({ ok: false, reason: "unknown_zone" });
  });

  it("refuses an unknown zone rather than assuming the cheapest", () => {
    expect(rateShipment(CARD, 2, null)).toEqual({ ok: false, reason: "unknown_zone" });
  });

  it("refuses a shipment with no weight", () => {
    expect(rateShipment(CARD, null, 1)).toEqual({ ok: false, reason: "no_weight" });
  });

  it("refuses a zero or negative weight", () => {
    expect(rateShipment(CARD, 0, 1)).toEqual({ ok: false, reason: "no_weight" });
    expect(rateShipment(CARD, -1, 1)).toEqual({ ok: false, reason: "no_weight" });
  });
});

describe("rateBand", () => {
  // A band states what is actually known while the zone chart is missing.
  // Zone 8 is about a third dearer than zone 1, so a midpoint would be a
  // number nobody could defend and everyone would quote.
  it("spans the cheapest and dearest zone for the charged break", () => {
    expect(rateBand(CARD, 2.35)).toEqual({
      ok: true, minCents: 783, maxCents: 1149, cheapestZone: 1, dearestZone: 8, breakWeightLb: 2.5,
    });
  });

  it("uses the rounded-up break, like a real rating", () => {
    const b = rateBand(CARD, 1.02);
    expect(b.ok && b.breakWeightLb).toBe(1.5);
  });

  it("refuses a parcel the card cannot price at any zone", () => {
    expect(rateBand(CARD, 99)).toEqual({ ok: false, reason: "over_max_weight" });
  });

  it("refuses a shipment with no weight", () => {
    expect(rateBand(CARD, null)).toEqual({ ok: false, reason: "no_weight" });
  });
});

describe("a card with a gap", () => {
  // Guards the lookup against a card transcribed with a missing zone column.
  const broken: RateCard = {
    ...CARD,
    breaks: [{ weightLb: 1, fuelSurchargeCents: 30, zoneRatesCents: [498] }],
    zones: [1],
  };

  it("prices only the zone it has", () => {
    expect(rateShipment(broken, 1, 1).ok).toBe(true);
    expect(rateShipment(broken, 1, 2)).toEqual({ ok: false, reason: "unknown_zone" });
  });
});
