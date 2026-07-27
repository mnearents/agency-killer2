import { describe, it, expect } from "vitest";
import {
  parseEnrollments,
  computeEnrollmentLtv,
  computeEnrollmentLtvSummary,
  getMonthlyPriceCents,
} from "@/domain/shopify/enrollment-ltv";

const AS_OF = "2026-07";

// ─── Pricing ──────────────────────────────────────────────────────────

describe("getMonthlyPriceCents", () => {
  it("returns $5 for t1 before RAD cutover", () => {
    expect(getMonthlyPriceCents("t1", "2024-06")).toBe(500);
  });

  it("returns $8 for t1 after RAD cutover", () => {
    expect(getMonthlyPriceCents("t1", "2025-08")).toBe(800);
  });

  it("returns $15 for t2 after RAD cutover", () => {
    expect(getMonthlyPriceCents("t2", "2025-08")).toBe(1500);
  });

  it("returns $5 for t2 before RAD cutover (only t1 existed)", () => {
    // Edge case: t2 shouldn't exist pre-RAD, but if it does, treat as Color Happy
    expect(getMonthlyPriceCents("t2", "2024-01")).toBe(500);
  });
});

// ─── Enrollment parsing + dedup ───────────────────────────────────────

describe("parseEnrollments", () => {
  it("parses valid JSON array of enrollments", () => {
    const json = JSON.stringify([
      { tier: "t1", month: "2025-01", month_id: 1 },
      { tier: "t1", month: "2025-02", month_id: 2 },
    ]);
    const result = parseEnrollments(json);
    expect(result).toHaveLength(2);
    expect(result[0].month).toBe("2025-01");
  });

  it("deduplicates by month", () => {
    const json = JSON.stringify([
      { tier: "t1", month: "2025-01", month_id: 1 },
      { tier: "t1", month: "2025-01", month_id: 2 }, // duplicate
      { tier: "t1", month: "2025-02", month_id: 3 },
    ]);
    const result = parseEnrollments(json);
    expect(result).toHaveLength(2);
  });

  it("keeps higher tier when same month has both t1 and t2", () => {
    const json = JSON.stringify([
      { tier: "t1", month: "2025-01", month_id: 1 },
      { tier: "t2", month: "2025-01", month_id: 2 }, // same month, higher tier
    ]);
    const result = parseEnrollments(json);
    expect(result).toHaveLength(1);
    expect(result[0].tier).toBe("t2");
  });

  it("sorts by month", () => {
    const json = JSON.stringify([
      { tier: "t1", month: "2025-03", month_id: 3 },
      { tier: "t1", month: "2025-01", month_id: 1 },
      { tier: "t1", month: "2025-02", month_id: 2 },
    ]);
    const result = parseEnrollments(json);
    expect(result[0].month).toBe("2025-01");
    expect(result[2].month).toBe("2025-03");
  });

  it("returns empty for invalid JSON", () => {
    expect(parseEnrollments("not json")).toHaveLength(0);
  });

  it("returns empty for empty array", () => {
    expect(parseEnrollments("[]")).toHaveLength(0);
  });

  it("skips entries without month or tier", () => {
    const json = JSON.stringify([
      { tier: "t1", month: "2025-01", month_id: 1 },
      { month_id: 2 }, // missing tier and month
      { tier: "t1", month_id: 3 }, // missing month
    ]);
    const result = parseEnrollments(json);
    expect(result).toHaveLength(1);
  });
});

// ─── Customer LTV ─────────────────────────────────────────────────────

describe("computeEnrollmentLtv", () => {
  it("computes LTV for a long-running subscriber", () => {
    // 12 months of t1 in the RAD era
    const enrollments = Array.from({ length: 12 }, (_, i) => ({
      tier: "t1",
      month: `2025-${String(i + 1).padStart(2, "0")}`,
      month_id: i,
    }));
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv).not.toBeNull();
    expect(ltv!.totalMonths).toBe(12);
    expect(ltv!.currentTier).toBe("t1");
    expect(ltv!.isActive).toBe(false); // last enrollment is 2025-12, asOf is 2026-07
  });

  it("computes accurate LTV spanning Color Happy and RAD eras", () => {
    const enrollments = [
      // 3 months Color Happy ($5/mo = 1500 cents)
      { tier: "t1", month: "2024-10", month_id: 1 },
      { tier: "t1", month: "2024-11", month_id: 2 },
      { tier: "t1", month: "2024-12", month_id: 3 },
      // 3 months RAD t1 ($8/mo = 2400 cents)
      { tier: "t1", month: "2025-07", month_id: 4 },
      { tier: "t1", month: "2025-08", month_id: 5 },
      { tier: "t1", month: "2025-09", month_id: 6 },
    ];
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv!.totalMonths).toBe(6);
    expect(ltv!.t1Months).toBe(6);
    expect(ltv!.estimatedLtvCents).toBe(1500 + 2400); // 3900
  });

  it("handles tier upgrade from t1 to t2", () => {
    const enrollments = [
      { tier: "t1", month: "2026-01", month_id: 1 },
      { tier: "t1", month: "2026-02", month_id: 2 },
      { tier: "t2", month: "2026-03", month_id: 3 },
      { tier: "t2", month: "2026-04", month_id: 4 },
    ];
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv!.currentTier).toBe("t2");
    expect(ltv!.t1Months).toBe(2);
    expect(ltv!.t2Months).toBe(2);
    // 2 * $8 + 2 * $15 = 1600 + 3000 = 4600
    expect(ltv!.estimatedLtvCents).toBe(4600);
  });

  it("marks customer as active if enrolled in current or previous month", () => {
    const enrollments = [
      { tier: "t1", month: "2026-06", month_id: 1 },
      { tier: "t1", month: "2026-07", month_id: 2 }, // current month
    ];
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv!.isActive).toBe(true);
  });

  it("marks customer as churned if no recent enrollment", () => {
    const enrollments = [
      { tier: "t1", month: "2025-01", month_id: 1 },
      { tier: "t1", month: "2025-02", month_id: 2 },
    ];
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv!.isActive).toBe(false);
  });

  it("ignores future enrollments beyond asOf month", () => {
    const enrollments = [
      { tier: "t1", month: "2026-06", month_id: 1 },
      { tier: "t1", month: "2026-07", month_id: 2 }, // current
      { tier: "t1", month: "2027-01", month_id: 3 }, // future
      { tier: "t1", month: "2027-02", month_id: 4 }, // future
    ];
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv!.totalMonths).toBe(2); // only current and past
  });

  it("deduplicates before computing", () => {
    const enrollments = [
      { tier: "t1", month: "2026-01", month_id: 1 },
      { tier: "t1", month: "2026-01", month_id: 2 }, // dupe
      { tier: "t2", month: "2026-01", month_id: 3 }, // same month different tier
      { tier: "t1", month: "2026-02", month_id: 4 },
    ];
    const json = JSON.stringify(enrollments);

    const ltv = computeEnrollmentLtv("c1", json, AS_OF);
    expect(ltv!.totalMonths).toBe(2); // Jan (deduped) + Feb
  });

  it("returns null for empty enrollments", () => {
    expect(computeEnrollmentLtv("c1", "[]", AS_OF)).toBeNull();
    expect(computeEnrollmentLtv("c1", "invalid", AS_OF)).toBeNull();
  });
});

// ─── Summary ──────────────────────────────────────────────────────────

describe("computeEnrollmentLtvSummary", () => {
  it("computes summary across multiple customers", () => {
    const customers = [
      {
        customerId: "c1",
        enrollments: JSON.stringify([
          { tier: "t1", month: "2026-01", month_id: 1 },
          { tier: "t1", month: "2026-02", month_id: 2 },
          { tier: "t1", month: "2026-03", month_id: 3 },
          { tier: "t1", month: "2026-04", month_id: 4 },
          { tier: "t1", month: "2026-05", month_id: 5 },
          { tier: "t1", month: "2026-06", month_id: 6 },
          { tier: "t1", month: "2026-07", month_id: 7 }, // active
        ]),
      },
      {
        customerId: "c2",
        enrollments: JSON.stringify([
          { tier: "t2", month: "2026-05", month_id: 1 },
          { tier: "t2", month: "2026-06", month_id: 2 },
          { tier: "t2", month: "2026-07", month_id: 3 }, // active
        ]),
      },
      {
        customerId: "c3",
        enrollments: JSON.stringify([
          { tier: "t1", month: "2025-01", month_id: 1 },
          { tier: "t1", month: "2025-02", month_id: 2 }, // churned
        ]),
      },
    ];

    const summary = computeEnrollmentLtvSummary(customers, AS_OF);
    expect(summary.totalSubscribers).toBe(3);
    expect(summary.activeSubscribers).toBe(2);
    expect(summary.churnedSubscribers).toBe(1);
    expect(summary.t1Summary.subscribers).toBe(2); // c1 + c3
    expect(summary.t2Summary.subscribers).toBe(1); // c2
  });

  it("handles empty customer list", () => {
    const summary = computeEnrollmentLtvSummary([], AS_OF);
    expect(summary.totalSubscribers).toBe(0);
  });
});
