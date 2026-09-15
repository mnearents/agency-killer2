/**
 * Experiments — the accountability layer, and the fold that turns two
 * append-only records into a readable experiment.
 *
 * ## What this exists to stop
 *
 * An analysis makes a recommendation, someone acts on it, results come in
 * ambiguous, and the interpretation gets fitted to them afterwards. Nobody
 * lies. The bar simply moves, because there was never a written bar to move
 * from. Six months later there is a shared belief that something worked, held
 * by everyone and traceable to nothing.
 *
 * ## Why two records rather than one row
 *
 * The declaration and the results are separate, both insert-only. That makes
 * the important guarantee structural instead of conventional: **there is no
 * code path that edits success criteria once the answer is known**, because
 * recording a result writes a different record entirely. A rule saying "don't
 * edit the bar" is a wish; not having an UPDATE is a guarantee.
 *
 * It is the same reasoning that makes `pilot_notes` an append-only log of
 * entries rather than a table with a mutable status, and it applies here with
 * more force — the whole value of the record is that one field was written
 * before the outcome was known.
 *
 * ## Status is derived, never stored
 *
 * A stored `running` that nobody updates is the exact shape of every silent
 * failure in this codebase: it reports a healthy state while doing nothing.
 * Derived from the declared window and the results, it cannot go stale — and
 * it can distinguish an experiment that is genuinely in flight from one whose
 * window closed and that nobody ever concluded, which is the folklore case.
 *
 * Pure functions only — no database, no clock. The caller supplies both.
 */

/** The outcomes a human can record. `running` is not among them: see below. */
export const OUTCOMES = ["win", "loss", "inconclusive"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * `running` and `awaiting_result` are derived from the *absence* of a result,
 * so they are states, not outcomes. Recording one would mean writing a row that
 * says there is no row.
 *
 * `awaiting_result` is the one that earns its keep. An experiment started and
 * never concluded is exactly what becomes "we tried that once and it worked"
 * eighteen months later; collapsing it into `running` would leave it looking
 * healthy forever.
 */
export type ExperimentStatus = Outcome | "running" | "awaiting_result";

export interface ExperimentDeclaration {
  id: string;
  name: string;
  hypothesis: string;
  whatWeChanged: string;
  /** Written before the result is known. The point of the whole table. */
  successCriteria: string;
  primaryMetric: string;
  /** Optional: some experiments genuinely have no prior number. */
  baselineValue: number | null;
  /** Never optional. How the baseline was computed, or why there isn't one. */
  baselineBasis: string;
  startDate: string;
  /** Declared up front, so the window cannot be extended until it looks good. */
  plannedEndDate: string;
  relatedNoteIds: string[];
  author: string;
  createdAt: Date;
}

export interface ExperimentResultEntry {
  id: string;
  experimentId: string;
  outcome: Outcome;
  resultValue: number | null;
  concludedOn: string;
  /** Required. An inconclusive result with nothing written down is folklore. */
  learnings: string;
  author: string;
  createdAt: Date;
}

export interface Experiment extends ExperimentDeclaration {
  status: ExperimentStatus;
  /** The newest result, or null while there is none. */
  result: ExperimentResultEntry | null;
  /** Earlier results, oldest first. Kept, because a changed reading is data. */
  supersededResults: ExperimentResultEntry[];
  lastActivityAt: Date;
}

export interface FoldedExperiments {
  experiments: Experiment[];
  /**
   * Results whose experiment was never declared. Not promoted to experiments —
   * that would invent one with no success criteria, which is the failure this
   * table exists to prevent — and not dropped, which would hide a write that
   * happened.
   */
  orphanedResults: ExperimentResultEntry[];
}

const MAX_TEXT_LENGTH = 20_000;
const MAX_NAME_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ─── Validation ───────────────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; error: string };

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  // Date accepts 2026-02-30 and rolls it into March. Round-tripping catches
  // that, so a typo fails instead of quietly shifting a window.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function requireText(value: unknown, field: string, max = MAX_TEXT_LENGTH): ValidationResult {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return { ok: false, error: `"${field}" is required and cannot be empty` };
  if (text.length > max) {
    return { ok: false, error: `"${field}" is too long (${text.length} > ${max} characters)` };
  }
  return { ok: true };
}

/**
 * Fail closed. The caller is a model producing untyped JSON on a write path.
 *
 * `successCriteria` is checked like every other required field, which is the
 * point: it is not a nullable column with a convention attached to it.
 */
export function validateDeclaration(draft: ExperimentDeclaration): ValidationResult {
  for (const [field, max] of [
    ["name", MAX_NAME_LENGTH],
    ["hypothesis", MAX_TEXT_LENGTH],
    ["whatWeChanged", MAX_TEXT_LENGTH],
    ["successCriteria", MAX_TEXT_LENGTH],
    ["primaryMetric", MAX_NAME_LENGTH],
    ["baselineBasis", MAX_TEXT_LENGTH],
    ["author", MAX_NAME_LENGTH],
  ] as const) {
    const check = requireText(draft[field], field, max);
    if (!check.ok) return check;
  }

  if (draft.baselineValue !== null && !Number.isFinite(draft.baselineValue)) {
    return { ok: false, error: `"baselineValue" must be a number or null` };
  }

  for (const field of ["startDate", "plannedEndDate"] as const) {
    if (!isCalendarDate(draft[field])) {
      return { ok: false, error: `"${field}" must be a real calendar date in YYYY-MM-DD format` };
    }
  }

  // An end date chosen once the answer is known is a movable bar in the time
  // dimension: run it until it looks good, then stop.
  if (draft.plannedEndDate < draft.startDate) {
    return {
      ok: false,
      error: `"plannedEndDate" (${draft.plannedEndDate}) is before "startDate" (${draft.startDate})`,
    };
  }

  return { ok: true };
}

export function validateResult(draft: ExperimentResultEntry): ValidationResult {
  const experimentId = requireText(draft.experimentId, "experimentId", MAX_NAME_LENGTH);
  if (!experimentId.ok) return experimentId;

  if (!(OUTCOMES as readonly string[]).includes(draft.outcome)) {
    return {
      ok: false,
      error:
        `"outcome" must be one of: ${OUTCOMES.join(", ")}. ` +
        `"running" and "awaiting_result" are derived from having no result yet, ` +
        `so they cannot be recorded as one.`,
    };
  }

  // Inconclusive is expected to be the most common outcome on a business this
  // size, and this field is where it earns its keep — usually the finding is
  // that the metric was wrong, the window too short, or the change too small.
  const learnings = requireText(draft.learnings, "learnings");
  if (!learnings.ok) return learnings;

  if (!isCalendarDate(draft.concludedOn)) {
    return { ok: false, error: `"concludedOn" must be a real calendar date in YYYY-MM-DD format` };
  }

  if (draft.resultValue !== null && !Number.isFinite(draft.resultValue)) {
    return { ok: false, error: `"resultValue" must be a number or null` };
  }

  const author = requireText(draft.author, "author", MAX_NAME_LENGTH);
  if (!author.ok) return author;

  return { ok: true };
}

// ─── Folding ──────────────────────────────────────────────────────────

function byTimeThenId(a: ExperimentResultEntry, b: ExperimentResultEntry): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  // Two results can share a timestamp. Falling back to id keeps the fold
  // deterministic instead of depending on sort stability.
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

/**
 * Join declarations to their results and derive each experiment's status.
 *
 * `today` is a YYYY-MM-DD string supplied by the caller, never read from a
 * clock here — the same experiment must fold identically in a test and in
 * production.
 */
export function foldExperiments(
  declarations: ExperimentDeclaration[],
  results: ExperimentResultEntry[],
  today: string
): FoldedExperiments {
  const declared = new Map(declarations.map((d) => [d.id, d]));
  const byExperiment = new Map<string, ExperimentResultEntry[]>();
  const orphanedResults: ExperimentResultEntry[] = [];

  for (const r of results) {
    if (!declared.has(r.experimentId)) {
      orphanedResults.push(r);
      continue;
    }
    const list = byExperiment.get(r.experimentId);
    if (list) list.push(r);
    else byExperiment.set(r.experimentId, [r]);
  }

  const experiments: Experiment[] = declarations.map((d) => {
    const ordered = [...(byExperiment.get(d.id) ?? [])].sort(byTimeThenId);
    const latest = ordered.at(-1) ?? null;

    const status: ExperimentStatus = latest
      ? latest.outcome
      : today > d.plannedEndDate
        ? "awaiting_result"
        : "running";

    return {
      ...d,
      status,
      result: latest,
      supersededResults: ordered.slice(0, -1),
      lastActivityAt: latest ? latest.createdAt : d.createdAt,
    };
  });

  // Newest activity first: the thing that changed most recently is the thing
  // most likely to matter.
  experiments.sort((a, b) => {
    const diff = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  return { experiments, orphanedResults: [...orphanedResults].sort(byTimeThenId) };
}
