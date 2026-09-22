import { describe, it, expect } from "vitest";
import {
  parseShipmentsCsv,
  postageCoverage,
  toDate,
  CARRIERS_BILLED_ELSEWHERE,
} from "@/domain/economics/parse-shipments-csv";

const HEADER =
  "Shipping Label ID,Order Number,Order date,Created at,Carrier,Shipping Method," +
  "Tracking Number,Weight (lb),Total Shipping Charged,Label Cost,State,Zip,Country," +
  "Length (in),Width (in),Height (in)";

interface Spec {
  id?: string; order?: string; created?: string; carrier?: string; method?: string;
  weight?: string; charged?: string; cost?: string;
}

function csv(specs: Spec[]): string {
  return [
    HEADER,
    ...specs.map((s) =>
      [
        s.id ?? "L1", s.order ?? "RH354748", "2026-09-01", s.created ?? "2026-09-04 11:09:07",
        s.carrier ?? "dhl_ecommerce", s.method ?? "DHL BPM Ground", "TRK1",
        s.weight ?? "2.35", s.charged ?? "4.50", s.cost ?? "0.00", "UT", "84043", "US",
        "23.00", "17.50", "1.50",
      ].join(","),
    ),
  ].join("\n");
}

describe("parseShipmentsCsv", () => {
  it("parses a shipment with a real label cost", () => {
    const r = parseShipmentsCsv(csv([{ method: "USPS Ground Advantage", cost: "14.15" }]));
    expect(r.rows[0].labelCostCents).toBe(1415);
    expect(r.rows[0].postageBasis).toBe("billed");
  });

  // 1,726 of 2,508 live shipments carry 0.00 on a service that is not free.
  // Read at face value they would understate physical COD by every BPM
  // shipment while the total still looked complete.
  it("reads a zero on a carrier billed elsewhere as unknown, not as free", () => {
    const r = parseShipmentsCsv(csv([{ method: "DHL BPM Ground", cost: "0.00" }]));
    expect(r.rows[0].postageBasis).toBe("unbilled");
    expect(r.rows[0].labelCostCents).toBeNull();
  });

  it("does not count an unbilled shipment towards known postage", () => {
    const r = parseShipmentsCsv(csv([
      { method: "DHL BPM Ground", cost: "0.00" },
      { method: "USPS Ground Advantage", cost: "14.15" },
    ]));
    expect(r.billedCents).toBe(1415);
    expect(r.billed).toBe(1);
    expect(r.unbilled).toBe(1);
  });

  // A genuine zero must stay expressible, or the distinction is lost in the
  // other direction.
  it("keeps a zero from a carrier that does bill through as a real zero", () => {
    const r = parseShipmentsCsv(csv([{ method: "Some Billed Method", cost: "0.00" }]));
    expect(r.rows[0].postageBasis).toBe("zero");
    expect(r.rows[0].labelCostCents).toBe(0);
  });

  // A new method showing up at zero is currently counted as genuinely free,
  // which is the wrong direction to be wrong in — so it is reported.
  it("reports an unfamiliar method seen at zero", () => {
    const r = parseShipmentsCsv(csv([{ method: "Brand New Service", cost: "0.00" }]));
    expect(r.unexpectedZeroMethods).toEqual(["Brand New Service"]);
  });

  it("does not report a known-unbilled method as unexpected", () => {
    const r = parseShipmentsCsv(csv([{ method: "DHL BPM Ground", cost: "0.00" }]));
    expect(r.unexpectedZeroMethods).toEqual([]);
  });

  it("names DHL BPM Ground as billed elsewhere", () => {
    expect(CARRIERS_BILLED_ELSEWHERE.has("DHL BPM Ground")).toBe(true);
  });

  it("normalises the order number so it joins shopify_orders", () => {
    expect(parseShipmentsCsv(csv([{ order: "rh354748" }])).rows[0].orderNumber).toBe("RH354748");
  });

  // Carrier rates are priced by zone, and a zone comes from the zip prefix.
  // State spans zones, so rating from it would be wrong without being visibly
  // wrong.
  it("keeps the destination postcode, which is what zones are derived from", () => {
    expect(parseShipmentsCsv(csv([{}])).rows[0].postalCode).toBe("84043");
  });

  // A 23in parcel at 1.3lb bills several times its weight-rated price, which
  // is what makes the wall calendars expensive. Dropping dimensions would
  // understate exactly the shipments that matter most.
  it("keeps the parcel dimensions", () => {
    const r = parseShipmentsCsv(csv([{}])).rows[0];
    expect([r.lengthIn, r.widthIn, r.heightIn]).toEqual([23, 17.5, 1.5]);
  });

  it("keeps what the customer was charged separate from what the label cost", () => {
    const r = parseShipmentsCsv(csv([{ charged: "4.50", cost: "14.15", method: "USPS Ground Advantage" }]));
    expect(r.rows[0].shippingChargedCents).toBe(450);
    expect(r.rows[0].labelCostCents).toBe(1415);
  });

  it("throws when the label cost column is absent", () => {
    expect(() => parseShipmentsCsv("Order Number,Shipping Method\nRH1,DHL BPM Ground")).toThrow(
      /Label Cost/,
    );
  });

  it("throws on an empty export rather than returning no shipments", () => {
    expect(() => parseShipmentsCsv("")).toThrow(/empty/);
  });

  it("reports columns it does not map", () => {
    const r = parseShipmentsCsv([HEADER + ",Packer Name", csv([{}]).split("\n")[1] + ",Someone"].join("\n"));
    expect(r.unknownColumns).toContain("Packer Name");
  });
});

describe("toDate", () => {
  it("takes the date off a timestamp", () => {
    expect(toDate("2026-09-04 11:09:07")).toBe("2026-09-04");
  });

  it("returns null for something that is not a date", () => {
    expect(toDate("n/a")).toBeNull();
    expect(toDate(null)).toBeNull();
  });
});

describe("postageCoverage", () => {
  // The headline cost looks identical whether postage is fully measured or
  // 31% measured, so the share has to travel with it as a value.
  it("reports the share of shipments whose postage is actually known", () => {
    const { rows } = parseShipmentsCsv(csv([
      { method: "DHL BPM Ground", cost: "0.00" },
      { method: "DHL BPM Ground", cost: "0.00" },
      { method: "USPS Ground Advantage", cost: "10.00" },
      { method: "USPS Ground Advantage", cost: "10.00" },
    ]));
    expect(postageCoverage(rows)).toEqual({
      shipments: 4, billed: 2, unbilled: 2, coverage: 0.5, knownCents: 2000,
    });
  });

  it("reports zero coverage rather than dividing by zero on an empty set", () => {
    expect(postageCoverage([])).toEqual({
      shipments: 0, billed: 0, unbilled: 0, coverage: 0, knownCents: 0,
    });
  });

  it("reports full coverage when every shipment is billed", () => {
    const { rows } = parseShipmentsCsv(csv([{ method: "USPS Ground Advantage", cost: "10.00" }]));
    expect(postageCoverage(rows).coverage).toBe(1);
  });
});
