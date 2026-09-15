/**
 * Reads and the two appends over the experiments tables.
 *
 * Thin by design: rows in, the pure functions in ./experiments decide
 * everything. There is deliberately **no update and no delete anywhere in this
 * module** — that absence is what makes the pre-declared success criteria a
 * guarantee rather than a convention. Recording a result inserts into a
 * different table; nothing can reach back and move the bar.
 *
 * If you are about to add an `updateExperiment` here, read #25 first.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { experiments, experimentResults } from "@/db/schema";
import type { ExperimentDeclaration, ExperimentResultEntry, Outcome } from "./experiments";

export async function getExperimentDeclarations(db: Db): Promise<ExperimentDeclaration[]> {
  const rows = await db.select().from(experiments).orderBy(desc(experiments.createdAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hypothesis: r.hypothesis,
    whatWeChanged: r.whatWeChanged,
    successCriteria: r.successCriteria,
    primaryMetric: r.primaryMetric,
    baselineValue: r.baselineValue,
    baselineBasis: r.baselineBasis,
    startDate: r.startDate,
    plannedEndDate: r.plannedEndDate,
    relatedNoteIds: r.relatedNoteIds ?? [],
    author: r.author,
    createdAt: r.createdAt,
  }));
}

export async function getExperimentResults(db: Db): Promise<ExperimentResultEntry[]> {
  const rows = await db
    .select()
    .from(experimentResults)
    .orderBy(desc(experimentResults.createdAt));

  return rows.map((r) => ({
    id: r.id,
    experimentId: r.experimentId,
    outcome: r.outcome as Outcome,
    resultValue: r.resultValue,
    concludedOn: r.concludedOn,
    learnings: r.learnings,
    author: r.author,
    createdAt: r.createdAt,
  }));
}

/** True when an experiment with this id has been declared. */
export async function experimentExists(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(eq(experiments.id, id))
    .limit(1);
  return row !== undefined;
}

/** Insert only. Declaring an experiment is the one chance to state its bar. */
export async function insertDeclaration(db: Db, decl: ExperimentDeclaration): Promise<void> {
  await db.insert(experiments).values({
    id: decl.id,
    name: decl.name,
    hypothesis: decl.hypothesis,
    whatWeChanged: decl.whatWeChanged,
    successCriteria: decl.successCriteria,
    primaryMetric: decl.primaryMetric,
    baselineValue: decl.baselineValue,
    baselineBasis: decl.baselineBasis,
    startDate: decl.startDate,
    plannedEndDate: decl.plannedEndDate,
    relatedNoteIds: decl.relatedNoteIds,
    author: decl.author,
    createdAt: decl.createdAt,
  });
}

/** Insert only. A corrected reading is a new row, never an edit to the old one. */
export async function insertResult(db: Db, entry: ExperimentResultEntry): Promise<void> {
  await db.insert(experimentResults).values({
    id: entry.id,
    experimentId: entry.experimentId,
    outcome: entry.outcome,
    resultValue: entry.resultValue,
    concludedOn: entry.concludedOn,
    learnings: entry.learnings,
    author: entry.author,
    createdAt: entry.createdAt,
  });
}
