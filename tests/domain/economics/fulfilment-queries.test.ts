import { describe, it, expect } from "vitest";
import { monthlyEquivalentCents } from "@/domain/economics/fulfilment-queries";

describe("monthlyEquivalentCents", () => {
  it("passes a monthly cost through unchanged", () => {
    expect(monthlyEquivalentCents(2500, "monthly")).toBe(2500);
  });

  it("spreads an annual cost over twelve months", () => {
    expect(monthlyEquivalentCents(12000, "annual")).toBe(1000);
  });

  // The 3PL bills fortnightly, which is 26 periods a year and not 24. Treating
  // it as twice-monthly understates every fixed cost it bills by 8%.
  it("converts a bill period at 26 a year, not 24", () => {
    expect(monthlyEquivalentCents(12500, "per_bill_period")).toBe(27083);
    expect(monthlyEquivalentCents(12500, "per_bill_period")).not.toBe(25000);
  });

  // A cadence nobody normalised must not silently contribute zero to a total
  // that still looks complete.
  it("returns null for a cadence it cannot convert", () => {
    expect(monthlyEquivalentCents(1000, "whenever")).toBeNull();
  });

  it("keeps a zero cost as zero rather than null", () => {
    expect(monthlyEquivalentCents(0, "monthly")).toBe(0);
  });
});
