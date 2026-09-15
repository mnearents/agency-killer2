/**
 * Reads and the two appends over the drafts tables.
 *
 * Thin by design: rows in, the pure functions in ./drafts decide everything.
 * **No UPDATE and no DELETE anywhere in this module.** A revision is a new
 * draft, and a change of mind is a new decision — so the body Tara reacted to
 * stays readable next to the reaction, and an approval cannot overwrite the
 * rejection that preceded it.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { drafts, draftDecisions } from "@/db/schema";
import type { RuleAudience } from "@/domain/voice/rules";
import type { Decision, DraftDecisionEntry, DraftRecord, DraftType } from "./drafts";

export interface StoredDraft extends DraftRecord {
  voiceRulesChecked: string[];
}

export async function getDrafts(db: Db): Promise<StoredDraft[]> {
  const rows = await db.select().from(drafts).orderBy(desc(drafts.createdAt));

  return rows.map((r) => ({
    id: r.id,
    type: r.type as DraftType,
    title: r.title,
    channel: r.channel as RuleAudience,
    body: r.body,
    voiceRulesChecked: r.voiceRulesChecked ?? [],
    author: r.author,
    createdAt: r.createdAt,
  }));
}

export async function getDraftDecisions(db: Db): Promise<DraftDecisionEntry[]> {
  const rows = await db
    .select()
    .from(draftDecisions)
    .orderBy(desc(draftDecisions.createdAt));

  return rows.map((r) => ({
    id: r.id,
    draftId: r.draftId,
    decision: r.decision as Decision,
    feedback: r.feedback,
    decidedBy: r.decidedBy,
    createdAt: r.createdAt,
  }));
}

export async function draftExists(db: Db, id: string): Promise<boolean> {
  const [row] = await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id)).limit(1);
  return row !== undefined;
}

/** Insert only. A revision is a new draft. */
export async function insertDraft(db: Db, draft: StoredDraft): Promise<void> {
  await db.insert(drafts).values({
    id: draft.id,
    type: draft.type,
    title: draft.title,
    channel: draft.channel,
    body: draft.body,
    voiceRulesChecked: draft.voiceRulesChecked,
    author: draft.author,
    createdAt: draft.createdAt,
  });
}

/** Insert only. A change of mind is a new decision, never an edit. */
export async function insertDraftDecision(db: Db, entry: DraftDecisionEntry): Promise<void> {
  await db.insert(draftDecisions).values({
    id: entry.id,
    draftId: entry.draftId,
    decision: entry.decision,
    feedback: entry.feedback,
    decidedBy: entry.decidedBy,
    createdAt: entry.createdAt,
  });
}
