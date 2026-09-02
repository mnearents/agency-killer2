import { describe, it, expect } from "vitest";
import {
  McpArgumentError,
  parseArgs,
  resolveRange,
} from "@/mcp/args";

const NOW = new Date("2026-09-01T18:30:00Z");

describe("parseArgs", () => {
  it("returns an empty object when a tool takes no arguments", () => {
    expect(parseArgs({}, {})).toEqual({});
  });

  it("treats a missing arguments object the same as no arguments", () => {
    expect(parseArgs(undefined, {})).toEqual({});
  });

  // A hallucinated parameter is the failure mode that matters: silently
  // dropping it makes the model believe a filter applied that never did.
  it("rejects an argument the tool does not declare", () => {
    expect(() => parseArgs({ campaign: "x" }, {})).toThrow(McpArgumentError);
  });

  it("names the unexpected argument and what was allowed", () => {
    expect(() =>
      parseArgs({ campain: "x" }, { campaign: { type: "string" } })
    ).toThrow(/campain.*campaign/s);
  });

  it("fills in the declared default when an argument is omitted", () => {
    expect(parseArgs({}, { days: { type: "integer", default: 30 } })).toEqual({
      days: 30,
    });
  });

  it("omits an optional argument that has no default", () => {
    expect(parseArgs({}, { limit: { type: "integer" } })).toEqual({});
  });

  it("rejects a missing required argument", () => {
    expect(() =>
      parseArgs({}, { id: { type: "string", required: true } })
    ).toThrow(/id/);
  });

  describe("integers", () => {
    it("accepts an integer", () => {
      expect(parseArgs({ days: 7 }, { days: { type: "integer" } })).toEqual({ days: 7 });
    });

    it("accepts a numeric string, since JSON args arrive loosely typed", () => {
      expect(parseArgs({ days: "7" }, { days: { type: "integer" } })).toEqual({ days: 7 });
    });

    it("rejects a non-numeric string rather than coercing it to NaN", () => {
      expect(() => parseArgs({ days: "lots" }, { days: { type: "integer" } })).toThrow(
        McpArgumentError
      );
    });

    it("rejects a fractional value", () => {
      expect(() => parseArgs({ days: 7.5 }, { days: { type: "integer" } })).toThrow(
        McpArgumentError
      );
    });

    it("rejects a value below the declared minimum", () => {
      expect(() =>
        parseArgs({ days: 0 }, { days: { type: "integer", min: 1 } })
      ).toThrow(/at least 1/);
    });

    it("rejects a value above the declared maximum", () => {
      expect(() =>
        parseArgs({ limit: 5000 }, { limit: { type: "integer", max: 500 } })
      ).toThrow(/at most 500/);
    });
  });

  describe("booleans", () => {
    it("accepts a boolean", () => {
      expect(
        parseArgs({ includeHealthy: true }, { includeHealthy: { type: "boolean" } })
      ).toEqual({ includeHealthy: true });
    });

    it("rejects a string that merely looks boolean", () => {
      expect(() =>
        parseArgs({ includeHealthy: "true" }, { includeHealthy: { type: "boolean" } })
      ).toThrow(McpArgumentError);
    });
  });

  describe("enums", () => {
    it("accepts a declared value", () => {
      expect(
        parseArgs({ channel: "Email" }, { channel: { type: "enum", values: ["Email", "SMS"] } })
      ).toEqual({ channel: "Email" });
    });

    it("rejects an undeclared value and lists the valid ones", () => {
      expect(() =>
        parseArgs({ channel: "Carrier Pigeon" }, { channel: { type: "enum", values: ["Email", "SMS"] } })
      ).toThrow(/Email.*SMS/s);
    });
  });

  describe("dates", () => {
    it("parses a YYYY-MM-DD date as UTC midnight", () => {
      const parsed = parseArgs({ startDate: "2026-08-15" }, { startDate: { type: "date" } });
      expect((parsed.startDate as Date).toISOString()).toBe("2026-08-15T00:00:00.000Z");
    });

    it("rejects a date that is not YYYY-MM-DD", () => {
      expect(() => parseArgs({ startDate: "08/15/2026" }, { startDate: { type: "date" } })).toThrow(
        McpArgumentError
      );
    });

    // "2026-02-30" parses fine via Date and silently rolls into March.
    it("rejects a well-formed date that does not exist on the calendar", () => {
      expect(() => parseArgs({ startDate: "2026-02-30" }, { startDate: { type: "date" } })).toThrow(
        McpArgumentError
      );
    });
  });
});

describe("resolveRange", () => {
  it("defaults to a trailing window ending now", () => {
    const range = resolveRange({}, NOW, 30);
    expect(range.endDate.toISOString()).toBe("2026-09-01T18:30:00.000Z");
    expect(range.startDate.toISOString()).toBe("2026-08-02T18:30:00.000Z");
  });

  it("honours an explicit day count", () => {
    const range = resolveRange({ days: 7 }, NOW, 30);
    expect(range.startDate.toISOString()).toBe("2026-08-25T18:30:00.000Z");
  });

  // The calendar is about what's planned, so the same `days` must look ahead.
  it("counts forward from now when asked to", () => {
    const range = resolveRange({ days: 7 }, NOW, 30, "forward");
    expect(range.startDate.toISOString()).toBe("2026-09-01T18:30:00.000Z");
    expect(range.endDate.toISOString()).toBe("2026-09-08T18:30:00.000Z");
  });

  it("uses explicit dates when both are given", () => {
    const range = resolveRange(
      { startDate: new Date("2026-07-01T00:00:00Z"), endDate: new Date("2026-07-31T00:00:00Z") },
      NOW,
      30
    );
    expect(range.startDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  // An end date of the 31st that stops at midnight silently drops a day of data.
  it("extends an explicit end date to cover the whole day", () => {
    const range = resolveRange(
      { startDate: new Date("2026-07-01T00:00:00Z"), endDate: new Date("2026-07-31T00:00:00Z") },
      NOW,
      30
    );
    expect(range.endDate.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it("rejects a start date without an end date, rather than guessing one", () => {
    expect(() => resolveRange({ startDate: new Date("2026-07-01T00:00:00Z") }, NOW, 30)).toThrow(
      McpArgumentError
    );
  });

  it("rejects a range that runs backwards", () => {
    expect(() =>
      resolveRange(
        { startDate: new Date("2026-07-31T00:00:00Z"), endDate: new Date("2026-07-01T00:00:00Z") },
        NOW,
        30
      )
    ).toThrow(/before/);
  });

  it("rejects days combined with explicit dates as an ambiguous request", () => {
    expect(() =>
      resolveRange(
        {
          days: 7,
          startDate: new Date("2026-07-01T00:00:00Z"),
          endDate: new Date("2026-07-31T00:00:00Z"),
        },
        NOW,
        30
      )
    ).toThrow(McpArgumentError);
  });
});
