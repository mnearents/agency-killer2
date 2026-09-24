import { describe, it, expect } from "vitest";
import {
  DHL_BPM_GROUND_2026,
  USPS_MEDIA_MAIL_2026,
  MEDIA_MAIL_ELIGIBILITY_NOTE,
  rateShipment,
  rateBand,
  dimensionalWeightLb,
  billableWeightLb,
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

describe("dimensionalWeightLb", () => {
  it("is volume over the divisor", () => {
    expect(dimensionalWeightLb(23, 17.5, 1.5, 166)).toBeCloseTo(3.637, 3);
  });

  // The divisor is carrier- and contract-specific, and 139 vs 194 is 40% of
  // the billed weight. A default would be a confident number nobody can check.
  it("takes the divisor as a required input", () => {
    expect(dimensionalWeightLb(23, 17.5, 1.5, 139)).toBeGreaterThan(
      dimensionalWeightLb(23, 17.5, 1.5, 194)!,
    );
  });

  it("returns null when a dimension is missing", () => {
    expect(dimensionalWeightLb(23, null, 1.5, 166)).toBeNull();
  });

  it("returns null for a zero dimension rather than a zero weight", () => {
    expect(dimensionalWeightLb(23, 17.5, 0, 166)).toBeNull();
  });
});

describe("billableWeightLb", () => {
  const CALENDAR = { lengthIn: 23, widthIn: 17.5, heightIn: 1.5 };

  // The fact that explains the bill: a 1.3lb wall calendar rates as ~3.6lb.
  it("uses dimensional weight when it exceeds actual, and says so", () => {
    const r = billableWeightLb(1.3, CALENDAR, 166);
    expect(r.ok && r.basis).toBe("dimensional");
    expect(r.ok && r.weightLb).toBeCloseTo(3.637, 3);
  });

  it("uses actual weight when it is the greater", () => {
    const r = billableWeightLb(10, CALENDAR, 166);
    expect(r).toEqual({ ok: true, weightLb: 10, basis: "actual" });
  });

  it("falls back to dimensional when actual weight is missing", () => {
    const r = billableWeightLb(null, CALENDAR, 166);
    expect(r.ok && r.basis).toBe("dimensional");
  });

  it("uses actual weight when dimensions are missing", () => {
    const r = billableWeightLb(2, { lengthIn: null, widthIn: null, heightIn: null }, 166);
    expect(r).toEqual({ ok: true, weightLb: 2, basis: "actual" });
  });

  it("refuses when neither is available rather than returning zero", () => {
    expect(billableWeightLb(null, { lengthIn: null, widthIn: null, heightIn: null }, 166))
      .toEqual({ ok: false, reason: "no_weight" });
  });
});

describe("USPS_MEDIA_MAIL_2026", () => {
  it("prices a single zone, because Media Mail is not zoned", () => {
    expect(USPS_MEDIA_MAIL_2026.zones).toEqual([1]);
  });

  it("carries no fuel surcharge — the card is a total per piece", () => {
    for (const b of USPS_MEDIA_MAIL_2026.breaks) {
      expect(b.fuelSurchargeCents, `break ${b.weightLb}lb`).toBe(0);
    }
  });

  it("has a break for every pound to 30", () => {
    expect(USPS_MEDIA_MAIL_2026.breaks.map((b) => b.weightLb)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });

  it("never gets cheaper as the parcel gets heavier", () => {
    const b = USPS_MEDIA_MAIL_2026.breaks;
    for (let i = 1; i < b.length; i++) {
      expect(b[i].zoneRatesCents[0]).toBeGreaterThan(b[i - 1].zoneRatesCents[0]);
    }
  });

  it("prices the first pound at the published rate", () => {
    expect(rateShipment(USPS_MEDIA_MAIL_2026, 1, null)).toEqual({
      ok: true, cents: 549, breakWeightLb: 1, zone: 1,
    });
  });

  // A one-zone card is zoneless: there is no zone for the caller to be
  // missing, so refusing without one would block every rating.
  it("rates without being given a zone", () => {
    expect(rateShipment(USPS_MEDIA_MAIL_2026, 2.35, null).ok).toBe(true);
  });

  // A zoned card must still refuse a missing zone — the special case is for
  // cards that genuinely have one zone, not a licence to guess.
  it("does not extend that licence to a zoned card", () => {
    expect(rateShipment(DHL_BPM_GROUND_2026, 2.35, null)).toEqual({
      ok: false, reason: "unknown_zone",
    });
  });

  // The whole reason for the switch: dimensional weight does not apply, so a
  // 1.45lb wall calendar rates on its weight rather than its footprint.
  it("rates a wall calendar at its actual weight", () => {
    const r = rateShipment(USPS_MEDIA_MAIL_2026, 1.45, null);
    expect(r).toEqual({ ok: true, cents: 641, breakWeightLb: 2, zone: 1 });
  });

  it("refuses a parcel over 30lb rather than pricing it at the top break", () => {
    expect(rateShipment(USPS_MEDIA_MAIL_2026, 31, null)).toEqual({
      ok: false, reason: "over_max_weight",
    });
  });

  // The rate card alone makes the switch look purely like a win. It is not
  // unconditional: Media Mail is restricted to reading matter, and blank
  // planners and calendars are the disputed cases.
  it("ships with the eligibility constraint recorded alongside the rates", () => {
    expect(MEDIA_MAIL_ELIGIBILITY_NOTE).toMatch(/postage due/i);
  });
});

import { estimatePostage, rollUpPostage } from "@/domain/economics/postage-rates";

describe("estimatePostage", () => {
  it("prefers a real charge over a rate card", () => {
    expect(estimatePostage(642, 2.35)).toEqual({ cents: 642, basis: "billed", ratedWeightLb: null });
  });

  // 69% of shipments bill to an account the 3PL does not invoice. Media Mail
  // is flat, so those can be computed rather than waited for.
  it("derives from weight when nothing was billed to us", () => {
    const e = estimatePostage(null, 1.45);
    expect(e).toMatchObject({ cents: 641, basis: "derived", ratedWeightLb: 2 });
    expect(e.note).toMatch(/an estimate, not a charge/);
  });

  it("cannot derive without a weight, and says so", () => {
    const e = estimatePostage(null, null);
    expect(e).toMatchObject({ cents: null, basis: "unknown" });
    expect(e.note).toMatch(/no weight recorded/);
  });

  it("cannot derive for a parcel over the card, and says why", () => {
    expect(estimatePostage(null, 99)).toMatchObject({ cents: null, basis: "unknown" });
  });

  // Deriving is only honest because Media Mail is flat. A zoned card cannot be
  // rated without knowing the zone.
  it("will not derive from a zoned card", () => {
    expect(estimatePostage(null, 2, DHL_BPM_GROUND_2026).basis).toBe("unknown");
  });

  it("treats a billed zero as billed, not missing", () => {
    expect(estimatePostage(0, 2).basis).toBe("billed");
  });
});

describe("rollUpPostage", () => {
  // A total mixing the two is indistinguishable from one anyone was charged.
  it("keeps billed and derived apart", () => {
    const r = rollUpPostage([
      estimatePostage(1000, null),
      estimatePostage(null, 1.45),
      estimatePostage(null, null),
    ]);
    expect(r).toMatchObject({ shipments: 3, billedCents: 1000, derivedCents: 641, unknown: 1 });
  });

  it("reports what share is a real charge", () => {
    expect(rollUpPostage([estimatePostage(100, null), estimatePostage(null, 1)]).billedShare).toBe(0.5);
  });

  it("reports zero share for an empty set rather than dividing by zero", () => {
    expect(rollUpPostage([]).billedShare).toBe(0);
  });
});
