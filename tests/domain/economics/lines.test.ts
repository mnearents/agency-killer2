import { describe, it, expect } from "vitest";
import {
  LINES,
  matchProduct,
  ADVERTISED_LINES,
  classifyProduct,
  assignOrderToLine,
  lineById,
} from "@/domain/economics/lines";

const p = (title: string, productType: string | null, tracked = true) => ({
  title, productType, tracked,
});

describe("the declaration", () => {
  it("advertises exactly the planners and the subscription", () => {
    expect(ADVERTISED_LINES.sort()).toEqual(["planners", "subscription"]);
  });

  it("gives every line a parent that the coarse classification already uses", () => {
    for (const l of LINES) {
      expect(["subscription", "physical", "digital"], l.id).toContain(l.parent);
    }
  });

  it("has unique line ids", () => {
    expect(new Set(LINES.map((l) => l.id)).size).toBe(LINES.length);
  });

  // A catch-all swallows every line declared after it.
  it("declares the physical catch-all after every named physical line", () => {
    const catchAll = LINES.findIndex((l) => l.match.catchAllPhysical);
    expect(LINES.findIndex((l) => l.id === "wall_calendars")).toBeLessThan(catchAll);
    expect(LINES.findIndex((l) => l.id === "planners")).toBeLessThan(catchAll);
  });

  it("declares the digital fallback last of all", () => {
    expect(LINES.findIndex((l) => l.match.catchAllDigital)).toBe(LINES.length - 1);
  });
});

describe("classifyProduct", () => {
  // The whole reason lines are declared: no product_type identifies a wall
  // calendar. Typed blank on 217 line items and Stationery on 7 (#43).
  it("finds a wall calendar however it is typed", () => {
    expect(classifyProduct(p("2026 Wall Calendar", ""))?.id).toBe("wall_calendars");
    expect(classifyProduct(p("2026 Wall Calendar", "Stationery"))?.id).toBe("wall_calendars");
    expect(classifyProduct(p("2026 Wall Calendar [Preorder]", null))?.id).toBe("wall_calendars");
  });

  it("puts planner stickers with the planners they accessorise", () => {
    expect(classifyProduct(p("2026 Planner Stickers", ""))?.id).toBe("planners");
    expect(classifyProduct(p("2026 Planner Stickers", "Stationery"))?.id).toBe("planners");
  });

  it("classifies a planner by its type", () => {
    expect(classifyProduct(p("2026 Dated 8x10 Planner - Doodle Edition", "Planners"))?.id)
      .toBe("planners");
  });

  it("classifies the subscription", () => {
    expect(classifyProduct(p("Really Awesome Doodles", "Subscription", false))?.id)
      .toBe("subscription");
  });

  it("classifies digital goods", () => {
    expect(classifyProduct(p("Printable pack", "Digital", false))?.id).toBe("digital");
  });

  it("sends an untyped physical product to other_physical, not to planners", () => {
    expect(classifyProduct(p("Happy Week Notepad", ""))?.id).toBe("other_physical");
  });

  // 2,866 line items of third-party return insurance. Revenue with no COGS and
  // no parcel; inside planners it would lift that line with money that buys
  // nothing.
  it("gives return protection its own line", () => {
    expect(classifyProduct(p("Free Unlimited Return  Valid in US.", "return", false))?.id)
      .toBe("return_protection");
  });

  // Everything has to land somewhere, but a fallback that reports identically
  // to a real match is undetectable.
  it("claims an untyped untracked product as digital, and says it was a fallback", () => {
    const m = matchProduct(p("Travel Log Printable", "", false));
    expect(m?.rule.id).toBe("digital");
    expect(m?.matchedBy).toBe("fallback");
  });

  it("reports a named type match as a rule, not a fallback", () => {
    expect(matchProduct(p("Printable pack", "Digital", false))?.matchedBy).toBe("rule");
  });

  // Order matters: a calendar must not be caught by a broader rule first.
  it("prefers the wall calendar rule over the physical catch-all", () => {
    expect(classifyProduct(p("2026 Wall Calendar", "Stationery", true))?.id).toBe("wall_calendars");
  });

  // A default line would absorb every unclassified product and still report a
  // plausible number, which is how a mis-typed product joins the population a
  // CPA is computed from.
  // A tracked product outranks the digital fallback: a stock count means a
  // physical thing, whatever its type says.
  it("prefers a stock count over the digital fallback", () => {
    expect(classifyProduct(p("Activity book", "Activity Books", true))?.id).toBe("other_physical");
  });

  it("is case-insensitive about titles", () => {
    expect(classifyProduct(p("2026 WALL CALENDAR", ""))?.id).toBe("wall_calendars");
  });
});

describe("assignOrderToLine", () => {
  const item = (title: string, type: string | null, revenueCents: number, tracked = true) => ({
    facts: p(title, type, tracked), revenueCents,
  });

  it("assigns a single-line order to that line", () => {
    const a = assignOrderToLine([item("2026 Dated 8x10 Planner", "Planners", 4200)]);
    expect(a).toMatchObject({ lineId: "planners", mixed: false, unassignedCents: 0 });
  });

  // Shipping is billed per parcel, so splitting it across lines would be an
  // allocation dressed as a measurement.
  it("assigns a mixed basket to the line carrying most of the revenue", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 4200),
      item("2026 Wall Calendar", "", 2400),
    ]);
    expect(a.lineId).toBe("planners");
    expect(a.mixed).toBe(true);
  });

  it("flags the basket as mixed so the share spanning lines is visible", () => {
    const a = assignOrderToLine([
      item("2026 Wall Calendar", "", 4200),
      item("Happy Week Notepad", "", 1900),
    ]);
    expect(a).toMatchObject({ lineId: "wall_calendars", mixed: true });
  });

  it("reports revenue per line within the order", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 4200),
      item("2026 Planner Stickers", "", 800),
      item("2026 Wall Calendar", "", 2400),
    ]);
    expect(a.revenueByLine).toEqual({ planners: 5000, wall_calendars: 2400 });
  });

  // Deterministic ties: the same basket must always land in the same line.
  it("breaks a revenue tie by declaration order, not map order", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 3000),
      item("2026 Wall Calendar", "", 3000),
    ]);
    expect(a.lineId).toBe("wall_calendars");
    const b = assignOrderToLine([
      item("2026 Wall Calendar", "", 3000),
      item("2026 Dated 8x10 Planner", "Planners", 3000),
    ]);
    expect(b.lineId).toBe("wall_calendars");
  });

  it("counts revenue no rule claimed, rather than dropping it", () => {
    const a = assignOrderToLine([item("2026 Dated 8x10 Planner", "Planners", 4200)]);
    expect(a.unassignedCents).toBe(0);
    expect(a.lineId).toBe("planners");
  });

  // Return protection rides along with thousands of orders. Counting it would
  // make most baskets look like they span lines, which reads as genuine basket
  // mixing and is not.
  it("does not treat an add-on as making a basket mixed", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 4200),
      item("Free Unlimited Return  Valid in US.", "return", 200, false),
    ]);
    expect(a.mixed).toBe(false);
    expect(a.lineId).toBe("planners");
  });

  it("still records the add-on's revenue against its own line", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 4200),
      item("Free Unlimited Return  Valid in US.", "return", 200, false),
    ]);
    expect(a.revenueByLine.return_protection).toBe(200);
  });

  // An add-on must never out-rank the product it accompanies, even if it
  // somehow carried more revenue.
  it("never assigns an order to an add-on line when a product line is present", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 100),
      item("Free Unlimited Return  Valid in US.", "return", 9000, false),
    ]);
    expect(a.lineId).toBe("planners");
  });

  it("counts revenue that arrived via a fallback separately", () => {
    const a = assignOrderToLine([
      item("2026 Dated 8x10 Planner", "Planners", 4200),
      item("Travel Log Printable", "", 900, false),
    ]);
    expect(a.fallbackCents).toBe(900);
  });

  it("counts nothing as fallback when every item matched a named rule", () => {
    expect(assignOrderToLine([item("2026 Wall Calendar", "", 4200)]).fallbackCents).toBe(0);
  });

  it("returns no line for an empty order rather than throwing", () => {
    expect(assignOrderToLine([])).toMatchObject({ lineId: null, mixed: false });
  });
});

describe("lineById", () => {
  it("finds a declared line", () => {
    expect(lineById("wall_calendars")?.advertised).toBe(false);
  });

  it("returns undefined for an unknown id", () => {
    expect(lineById("nope")).toBeUndefined();
  });
});
