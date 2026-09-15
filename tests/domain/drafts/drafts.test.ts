/**
 * Claude writes drafts. Claude never publishes.
 *
 * `status` records a human decision; it is not a workflow that produces one.
 * Nothing here can move a draft to `shipped` on its own, and nothing downstream
 * treats `approved` as authorisation to send — Attentive, Meta and Shopify stay
 * strictly read-only.
 *
 * That is worth stating plainly because a status enum containing `shipped`
 * reads like the beginning of a publishing pipeline, and the next person to
 * touch it will reasonably assume that was the intent. It was not.
 *
 * ## Why decisions are a log
 *
 * `taraFeedback` is the valuable column. Tara is the CEO, creative director,
 * and the voice being replicated — her rejections are the highest-signal
 * training data available, because a rejected draft plus the reason marks a
 * boundary the model crossed. The natural pull is to record why something was
 * approved and let rejections quietly disappear, which inverts the value.
 *
 * An append-only decision log makes disappearing impossible: a later approval
 * sits alongside the earlier rejection rather than overwriting it, and the
 * phrasing is preserved verbatim, because the phrasing is the point when the
 * subject is voice.
 */

import { describe, it, expect } from "vitest";
import {
  foldDrafts,
  validateDraft,
  validateDecision,
  DECISIONS,
  DRAFT_TYPES,
  isAgentAttribution,
  type DraftRecord,
  type DraftDecisionEntry,
} from "@/domain/drafts/drafts";

const T = (iso: string) => new Date(iso);

function draft(over: Partial<DraftRecord> = {}): DraftRecord {
  return {
    id: "d1",
    type: "email",
    title: "September planner launch",
    channel: "email",
    body: "Our new planners are here and they are lovely. Grab yours today.",
    author: "claude",
    createdAt: T("2026-09-01T10:00:00Z"),
    ...over,
  };
}

function decision(over: Partial<DraftDecisionEntry> = {}): DraftDecisionEntry {
  return {
    id: "dec1",
    draftId: "d1",
    decision: "rejected",
    feedback: "too polished, it doesn't sound like me. say 'y'all' somewhere.",
    decidedBy: "Tara",
    createdAt: T("2026-09-02T10:00:00Z"),
    ...over,
  };
}

describe("validateDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateDraft(draft())).toEqual({ ok: true });
  });

  it.each(["title", "body", "author"] as const)("refuses a draft with no %s", (field) => {
    expect(validateDraft(draft({ [field]: "   " } as never)).ok).toBe(false);
  });

  it("refuses a type it does not know", () => {
    expect(validateDraft(draft({ type: "billboard" as never })).ok).toBe(false);
    for (const type of DRAFT_TYPES) {
      expect(validateDraft(draft({ type })).ok, type).toBe(true);
    }
  });

  /**
   * The channel is the voice audience, reused rather than redeclared, because
   * the draft has to be checked against the rules for the channel it is
   * written for. A campaign brief nobody is publishing is `unspecified`, which
   * is excused from nothing.
   */
  it("refuses a channel that is not a voice audience", () => {
    expect(validateDraft(draft({ channel: "e-mail" as never })).ok).toBe(false);
    expect(validateDraft(draft({ channel: "unspecified" })).ok).toBe(true);
  });
});

describe("validateDecision: a decision belongs to a person", () => {
  it("accepts a decision attributed to a human", () => {
    expect(validateDecision(decision())).toEqual({ ok: true });
  });

  it("accepts every decision it can record", () => {
    for (const d of DECISIONS) {
      expect(validateDecision(decision({ decision: d })).ok, d).toBe(true);
    }
  });

  it("refuses 'draft' as a decision, since that is the absence of one", () => {
    expect(validateDecision(decision({ decision: "draft" as never })).ok).toBe(false);
  });

  /**
   * The realistic failure is not Claude impersonating Tara; it is Claude
   * defaulting `decidedBy` to "claude" the way every other write tool defaults
   * `author`, and a draft quietly reaching `approved` with no human in the
   * loop. Refusing an agent attribution costs nothing and closes that.
   */
  it.each(["claude", "Claude", "  claude  ", "agent", "system", "assistant", "ai"])(
    "refuses a decision attributed to %o",
    (decidedBy) => {
      const r = validateDecision(decision({ decidedBy }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/person|human/i);
    }
  );

  it("recognises an agent attribution wherever it is asked", () => {
    expect(isAgentAttribution("claude")).toBe(true);
    expect(isAgentAttribution("Tara")).toBe(false);
    expect(isAgentAttribution("Matt")).toBe(false);
  });

  it("refuses an empty attribution rather than accepting an anonymous decision", () => {
    expect(validateDecision(decision({ decidedBy: "   " })).ok).toBe(false);
  });

  /**
   * A rejection without a reason is the case this whole column exists for, and
   * it is the one most likely to be skipped. An approval can stand on its own.
   */
  it("requires feedback on a rejection", () => {
    expect(validateDecision(decision({ decision: "rejected", feedback: "  " })).ok).toBe(false);
    expect(validateDecision(decision({ decision: "approved", feedback: "" })).ok).toBe(true);
  });
});

describe("foldDrafts: status is the newest decision, and nothing is erased", () => {
  const fold = (d: DraftRecord[], dec: DraftDecisionEntry[]) => foldDrafts(d, dec);

  it("is a draft until someone decides", () => {
    const { drafts } = fold([draft()], []);
    expect(drafts[0].status).toBe("draft");
    expect(drafts[0].decisions).toEqual([]);
  });

  it("takes its status from the recorded decision", () => {
    for (const d of DECISIONS) {
      expect(fold([draft()], [decision({ decision: d })]).drafts[0].status).toBe(d);
    }
  });

  /**
   * The point of the log. Tara rejects with a reason, Claude rewrites, Tara
   * approves — and the rejection stays. Overwriting a status column would
   * delete the highest-signal record in the system at the exact moment it
   * became useful.
   */
  it("keeps a rejection after a later approval", () => {
    const rejected = decision({ id: "r1", decision: "rejected", createdAt: T("2026-09-02T10:00:00Z") });
    const approved = decision({
      id: "a1",
      decision: "approved",
      feedback: "much better",
      createdAt: T("2026-09-03T10:00:00Z"),
    });
    const { drafts } = fold([draft()], [approved, rejected]);

    expect(drafts[0].status).toBe("approved");
    expect(drafts[0].decisions.map((d) => d.id)).toEqual(["r1", "a1"]);
    expect(drafts[0].decisions[0].feedback).toContain("y'all");
  });

  it("collects every piece of feedback, oldest first, verbatim", () => {
    const one = decision({ id: "1", feedback: "too polished", createdAt: T("2026-09-02T10:00:00Z") });
    const two = decision({ id: "2", feedback: "still too polished", createdAt: T("2026-09-03T10:00:00Z") });
    const { drafts } = fold([draft()], [two, one]);
    expect(drafts[0].feedbackHistory).toEqual(["too polished", "still too polished"]);
  });

  it("orders decisions by time, not by the order they were handed over", () => {
    const early = decision({ id: "a", decision: "rejected", createdAt: T("2026-09-02T10:00:00Z") });
    const late = decision({ id: "b", decision: "approved", feedback: "", createdAt: T("2026-09-05T10:00:00Z") });
    expect(fold([draft()], [early, late]).drafts[0].status).toBe("approved");
    expect(fold([draft()], [late, early]).drafts[0].status).toBe("approved");
  });

  it("breaks a timestamp tie on id rather than on sort stability", () => {
    const at = T("2026-09-02T10:00:00Z");
    const a = decision({ id: "a", decision: "rejected", createdAt: at });
    const b = decision({ id: "b", decision: "approved", feedback: "", createdAt: at });
    expect(fold([draft()], [a, b]).drafts[0].status).toBe("approved");
    expect(fold([draft()], [b, a]).drafts[0].status).toBe("approved");
  });

  it("surfaces a decision whose draft does not exist rather than dropping it", () => {
    const { drafts, orphanedDecisions } = fold([draft()], [decision({ id: "x", draftId: "ghost" })]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("draft");
    expect(orphanedDecisions.map((d) => d.id)).toEqual(["x"]);
  });

  it("returns an empty fold over nothing", () => {
    expect(foldDrafts([], [])).toEqual({ drafts: [], orphanedDecisions: [] });
  });

  it("puts the most recently active draft first", () => {
    const older = draft({ id: "old", createdAt: T("2026-08-01T00:00:00Z") });
    const newer = draft({ id: "new", createdAt: T("2026-09-01T00:00:00Z") });
    expect(fold([older, newer], []).drafts.map((d) => d.id)).toEqual(["new", "old"]);
  });
});
