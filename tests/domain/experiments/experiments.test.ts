/**
 * The accountability layer. Without it, recommendations become folklore.
 *
 * The failure this table exists to stop is specific and nobody lies to produce
 * it: an analysis makes a recommendation, someone acts on it, the results come
 * in ambiguous, and the interpretation gets fitted to them afterwards. The bar
 * moves because there was never a written bar to move from.
 *
 * Two things follow, and both are structural here rather than conventional:
 *
 * 1. **`successCriteria` is required to start an experiment.** Not nullable,
 *    not fill-in-later. The moment it can be deferred it will be deferred on
 *    exactly the experiments whose outcome is least certain, which are the ones
 *    where it matters most.
 * 2. **Recording a result cannot touch the declaration.** The declaration and
 *    the results are separate append-only records, so there is no code path
 *    that edits a bar once the answer is known. A convention saying "don't edit
 *    success criteria" is a wish; not having an UPDATE is a guarantee.
 *
 * `outcome` is derived, never stored. A stored `running` that nobody updates is
 * the exact shape of every silent failure in this codebase.
 */

import { describe, it, expect } from "vitest";
import {
  foldExperiments,
  validateDeclaration,
  validateResult,
  OUTCOMES,
  type ExperimentDeclaration,
  type ExperimentResultEntry,
} from "@/domain/experiments/experiments";

const T = (iso: string) => new Date(iso);

function declaration(over: Partial<ExperimentDeclaration> = {}): ExperimentDeclaration {
  return {
    id: "exp1",
    name: "Restart Meta at $40/day",
    hypothesis: "Paid traffic recovers sitewide revenue faster than organic alone",
    whatWeChanged: "Turned on one Advantage+ campaign at $40/day",
    successCriteria: "Blended aMER at or above 1.84 over 21 days, measured Shopify-side",
    primaryMetric: "blended aMER",
    baselineValue: 1.62,
    baselineBasis: "30 days before the change, Shopify revenue over total ad spend",
    startDate: "2026-09-01",
    plannedEndDate: "2026-09-22",
    relatedNoteIds: [],
    author: "claude",
    createdAt: T("2026-09-01T10:00:00Z"),
    ...over,
  };
}

function result(over: Partial<ExperimentResultEntry> = {}): ExperimentResultEntry {
  return {
    id: "res1",
    experimentId: "exp1",
    outcome: "inconclusive",
    resultValue: 1.79,
    concludedOn: "2026-09-22",
    learnings: "21 days was too short to separate the effect from the back-to-school bump",
    author: "claude",
    createdAt: T("2026-09-22T10:00:00Z"),
    ...over,
  };
}

describe("validateDeclaration: the bar has to be written before the answer is known", () => {
  it("accepts a fully declared experiment", () => {
    expect(validateDeclaration(declaration())).toEqual({ ok: true });
  });

  // The one non-negotiable constraint on this table.
  it.each(["", "   ", null, undefined])(
    "refuses to start an experiment whose success criteria is %o",
    (successCriteria) => {
      const r = validateDeclaration(declaration({ successCriteria: successCriteria as never }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/success/i);
    }
  );

  it.each(["name", "hypothesis", "whatWeChanged", "primaryMetric", "baselineBasis", "author"] as const)(
    "refuses an experiment with no %s",
    (field) => {
      expect(validateDeclaration(declaration({ [field]: "  " } as never)).ok).toBe(false);
    }
  );

  /**
   * A baseline computed after the fact is computed by someone who already knows
   * the answer. There is no path to set one later, so the only question is
   * whether a missing number is an oversight or a genuine absence — hence a
   * required basis alongside an optional value. "No prior data, this ad format
   * has never run" is a real answer; a silent null is not.
   */
  it("allows an experiment with no numeric baseline, but not one with no stated basis", () => {
    expect(
      validateDeclaration(
        declaration({ baselineValue: null, baselineBasis: "no prior data; this format has never run" })
      ).ok
    ).toBe(true);
    expect(validateDeclaration(declaration({ baselineValue: null, baselineBasis: "" })).ok).toBe(false);
  });

  /**
   * An end date chosen once the answer is known is a movable bar in the time
   * dimension: run it until it looks good, then stop. Declaring the window is
   * the same discipline as declaring the criteria.
   */
  it("requires a planned end date that is not before the start", () => {
    expect(validateDeclaration(declaration({ plannedEndDate: "2026-08-31" })).ok).toBe(false);
    expect(validateDeclaration(declaration({ plannedEndDate: "2026-09-01" })).ok).toBe(true);
  });

  it.each(["2026-9-01", "not-a-date", "2026-02-30", ""])("refuses %o as a date", (bad) => {
    expect(validateDeclaration(declaration({ startDate: bad })).ok).toBe(false);
  });
});

describe("validateResult: an inconclusive result still has to say what was learned", () => {
  it("accepts a complete result", () => {
    expect(validateResult(result())).toEqual({ ok: true });
  });

  /**
   * Most marketing tests on a business this size will not reach significance,
   * so inconclusive should be the most common outcome. `learnings` is where it
   * earns its keep — usually that the metric was wrong, the window too short,
   * or the change too small to detect. An inconclusive result with nothing
   * written down is the folklore this table exists to prevent.
   */
  it.each(["", "   "])("refuses a result whose learnings are %o", (learnings) => {
    const r = validateResult(result({ learnings }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/learn/i);
  });

  it("accepts every outcome it can record", () => {
    for (const outcome of OUTCOMES) {
      expect(validateResult(result({ outcome })).ok, outcome).toBe(true);
    }
  });

  // `running` and `awaiting_result` are derived from the absence of a result.
  // Recording one would mean writing a row that says there is no row.
  it.each(["running", "awaiting_result", "win ", "Win", ""])(
    "refuses %o as a recordable outcome",
    (outcome) => {
      expect(validateResult(result({ outcome: outcome as never })).ok).toBe(false);
    }
  );

  it("refuses a result with no experiment to attach to", () => {
    expect(validateResult(result({ experimentId: "  " })).ok).toBe(false);
  });
});

describe("foldExperiments: status is derived, so it cannot go stale", () => {
  const fold = (d: ExperimentDeclaration[], r: ExperimentResultEntry[], today: string) =>
    foldExperiments(d, r, today);

  it("is running while the declared window is still open", () => {
    const { experiments } = fold([declaration()], [], "2026-09-10");
    expect(experiments[0].status).toBe("running");
  });

  /**
   * The folklore catcher. An experiment started and never concluded is exactly
   * the thing that becomes "we tried that once and it worked" eighteen months
   * later. Collapsing it into `running` would leave it looking healthy forever;
   * a system that reports a six-month-old test as in progress is not tracking
   * anything.
   */
  it("is awaiting a result once the declared end date has passed", () => {
    const { experiments } = fold([declaration()], [], "2026-09-23");
    expect(experiments[0].status).toBe("awaiting_result");
  });

  it("is still running on the planned end date itself", () => {
    expect(fold([declaration()], [], "2026-09-22").experiments[0].status).toBe("running");
  });

  it("takes its status from the recorded outcome once there is one", () => {
    for (const outcome of OUTCOMES) {
      const { experiments } = fold([declaration()], [result({ outcome })], "2026-09-23");
      expect(experiments[0].status, outcome).toBe(outcome);
    }
  });

  /**
   * The guarantee, asserted rather than asserted-about. Results are their own
   * records and carry nothing from the declaration, so no sequence of result
   * writes can change what the experiment said it was testing for.
   */
  it("reports the criteria that were declared, whatever results arrive later", () => {
    const declared = declaration().successCriteria;
    const { experiments } = fold(
      [declaration()],
      [result({ outcome: "win", resultValue: 99 }), result({ id: "res2", outcome: "loss" })],
      "2026-10-01"
    );
    expect(experiments[0].successCriteria).toBe(declared);
    expect(experiments[0].baselineValue).toBe(1.62);
  });

  /**
   * A correction is an append, as in pilot_notes. The newest result decides the
   * status and the earlier ones stay visible — overwriting them would erase the
   * fact that the reading changed, which is itself the interesting part.
   */
  it("lets a later result supersede an earlier one without erasing it", () => {
    const first = result({ id: "res1", outcome: "win", createdAt: T("2026-09-22T10:00:00Z") });
    const second = result({
      id: "res2",
      outcome: "inconclusive",
      learnings: "recount: the win was a duplicate-order artefact",
      createdAt: T("2026-09-25T10:00:00Z"),
    });
    const { experiments } = fold([declaration()], [second, first], "2026-10-01");

    expect(experiments[0].status).toBe("inconclusive");
    expect(experiments[0].result?.id).toBe("res2");
    expect(experiments[0].supersededResults.map((r) => r.id)).toEqual(["res1"]);
  });

  // Rows arrive in whatever order the database chose. Folding in argument
  // order would let an incidental ORDER BY decide an experiment's outcome.
  it("orders results by time, not by the order they were handed over", () => {
    const early = result({ id: "a", outcome: "win", createdAt: T("2026-09-22T10:00:00Z") });
    const late = result({ id: "b", outcome: "loss", createdAt: T("2026-09-30T10:00:00Z") });
    expect(fold([declaration()], [early, late], "2026-10-01").experiments[0].status).toBe("loss");
    expect(fold([declaration()], [late, early], "2026-10-01").experiments[0].status).toBe("loss");
  });

  it("breaks a timestamp tie on id rather than on sort stability", () => {
    const at = T("2026-09-22T10:00:00Z");
    const a = result({ id: "a", outcome: "win", createdAt: at });
    const b = result({ id: "b", outcome: "loss", createdAt: at });
    expect(fold([declaration()], [a, b], "2026-10-01").experiments[0].status).toBe("loss");
    expect(fold([declaration()], [b, a], "2026-10-01").experiments[0].status).toBe("loss");
  });

  /**
   * A result referencing an experiment that does not exist is data damage.
   * Promoting it to an experiment would invent one that was never declared —
   * with no success criteria, which is the whole point. Dropping it would hide
   * a write that happened. So it comes back separately.
   */
  it("surfaces a result with no declaration rather than inventing or dropping one", () => {
    const { experiments, orphanedResults } = fold(
      [declaration()],
      [result({ id: "stray", experimentId: "nope" })],
      "2026-10-01"
    );
    expect(experiments).toHaveLength(1);
    // The stray result belongs to no experiment, so it must not have counted
    // as this one being concluded.
    expect(experiments[0].status).toBe("awaiting_result");
    expect(experiments[0].result).toBeNull();
    expect(orphanedResults.map((r) => r.id)).toEqual(["stray"]);
  });

  it("returns an empty fold over nothing, and no orphans", () => {
    expect(foldExperiments([], [], "2026-10-01")).toEqual({ experiments: [], orphanedResults: [] });
  });

  it("puts the most recently active experiment first", () => {
    const older = declaration({ id: "old", name: "Older", createdAt: T("2026-08-01T00:00:00Z") });
    const newer = declaration({ id: "new", name: "Newer", createdAt: T("2026-09-01T00:00:00Z") });
    const { experiments } = fold([older, newer], [], "2026-09-10");
    expect(experiments.map((e) => e.id)).toEqual(["new", "old"]);
  });

  // A result on the older experiment makes it the most recently active one.
  it("counts a recorded result as activity", () => {
    const older = declaration({ id: "old", createdAt: T("2026-08-01T00:00:00Z"), plannedEndDate: "2026-08-20" });
    const newer = declaration({ id: "new", createdAt: T("2026-09-01T00:00:00Z") });
    const { experiments } = fold(
      [older, newer],
      [result({ experimentId: "old", createdAt: T("2026-09-05T00:00:00Z") })],
      "2026-09-10"
    );
    expect(experiments.map((e) => e.id)).toEqual(["old", "new"]);
  });
});
