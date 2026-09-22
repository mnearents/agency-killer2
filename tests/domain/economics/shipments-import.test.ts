import { describe, it, expect } from "vitest";
import { planShipmentImport } from "@/domain/economics/shipments-import";
import { parseShipmentsCsv } from "@/domain/economics/parse-shipments-csv";

const HEADER =
  "Shipping Label ID,Order Number,Order date,Created at,Carrier,Shipping Method," +
  "Tracking Number,Weight (lb),Total Shipping Charged,Label Cost,State,Zip,Country";

interface Spec { id?: string; order?: string; created?: string; method?: string; cost?: string }

const csv = (specs: Spec[]) =>
  [
    HEADER,
    ...specs.map((s, i) =>
      [
        s.id ?? `L${i + 1}`, s.order ?? "RH354748", "2026-09-01",
        s.created ?? "2026-09-04 11:09:07", "dhl_ecommerce",
        s.method ?? "USPS Ground Advantage", `TRK${i}`, "2.35", "4.50",
        s.cost ?? "10.00", "UT", "84043", "US",
      ].join(","),
    ),
  ].join("\n");

const plan = (specs: Spec[], known: string[] = ["RH354748"]) =>
  planShipmentImport({ parsed: parseShipmentsCsv(csv(specs)), knownOrderNumbers: known });

describe("planShipmentImport", () => {
  it("plans one row per label", () => {
    const r = plan([{}, { id: "L2" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.values).toHaveLength(2);
  });

  it("keys each row on the label id, so an overlapping re-import converges", () => {
    const r = plan([{ id: "LBL-99" }]);
    if (r.ok) expect(r.plan.values[0].id).toBe("LBL-99");
  });

  it("reports the date range the export covers", () => {
    const r = plan([{ created: "2026-08-01 10:00:00" }, { id: "L2", created: "2026-09-04 11:00:00" }]);
    if (r.ok) expect(r.plan.result.dateRange).toEqual({ from: "2026-08-01", to: "2026-09-04" });
  });

  // Coverage is the number that stops a floor being quoted as a total.
  it("reports postage coverage, not just cost", () => {
    const r = plan([
      { method: "DHL BPM Ground", cost: "0.00" },
      { id: "L2", method: "USPS Ground Advantage", cost: "10.00" },
    ]);
    if (r.ok) {
      expect(r.plan.result.coverage.coverage).toBe(0.5);
      expect(r.plan.result.coverage.knownCents).toBe(1000);
    }
  });

  it("warns that cost is a floor when any postage is billed elsewhere", () => {
    const r = plan([{ method: "DHL BPM Ground", cost: "0.00" }]);
    if (r.ok) expect(r.plan.result.warnings.join(" ")).toMatch(/is a floor/);
  });

  it("does not call cost a floor when every shipment is billed", () => {
    const r = plan([{ method: "USPS Ground Advantage", cost: "10.00" }]);
    if (r.ok) expect(r.plan.result.warnings.join(" ")).not.toMatch(/is a floor/);
  });

  it("warns about a method at zero that is not known to be billed elsewhere", () => {
    const r = plan([{ method: "Generic", cost: "0.00" }]);
    if (r.ok) expect(r.plan.result.warnings.join(" ")).toMatch(/Generic/);
  });

  // Postage attributed to no order silently leaves cost of delivery.
  it("names order references that will not join", () => {
    const r = plan([{ order: "BINGODONATION" }, { id: "L2", order: "RH354748" }]);
    if (r.ok) {
      expect(r.plan.result.orders.matched).toBe(1);
      expect(r.plan.result.warnings.join(" ")).toMatch(/BINGODONATION/);
    }
  });

  it("refuses an export where nothing joins at all", () => {
    const r = plan([{ order: "RH999999" }], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/postage would vanish/);
  });

  it("refuses rows with no label id, which could not converge on re-import", () => {
    const content = [HEADER, `,RH354748,2026-09-01,2026-09-04,dhl,USPS Ground Advantage,T,1,1.00,1.00,UT,84043,US`].join("\n");
    const r = planShipmentImport({ parsed: parseShipmentsCsv(content), knownOrderNumbers: ["RH354748"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no label id/);
  });

  it("stores an unbilled label cost as null, not zero", () => {
    const r = plan([{ method: "DHL BPM Ground", cost: "0.00" }]);
    if (r.ok) {
      expect(r.plan.values[0].labelCostCents).toBeNull();
      expect(r.plan.values[0].postageBasis).toBe("unbilled");
    }
  });

  it("carries the destination postcode onto the row it will insert", () => {
    const r = plan([{}]);
    if (r.ok) expect(r.plan.values[0].postalCode).toBe("84043");
  });

  it("carries a real cost through unchanged", () => {
    const r = plan([{ method: "USPS Ground Advantage", cost: "14.15" }]);
    if (r.ok) expect(r.plan.values[0].labelCostCents).toBe(1415);
  });
});
