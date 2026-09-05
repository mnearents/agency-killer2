/**
 * Reads and the single append over the pilot_notes log.
 *
 * Thin by design: rows in, pure functions in ./notes decide everything. The
 * insert here is the only write the MCP server performs, and it is an INSERT
 * with no update or delete path anywhere in the module — the append-only
 * guarantee is enforced by there being no other code, not by convention.
 */

import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { pilotNotes } from "@/db/schema";
import type { NoteKind, PilotEntry } from "./notes";

export async function getPilotEntries(db: Db): Promise<PilotEntry[]> {
  const rows = await db
    .select({
      id: pilotNotes.id,
      noteId: pilotNotes.noteId,
      kind: pilotNotes.kind,
      title: pilotNotes.title,
      body: pilotNotes.body,
      category: pilotNotes.category,
      author: pilotNotes.author,
      createdAt: pilotNotes.createdAt,
    })
    .from(pilotNotes)
    .orderBy(desc(pilotNotes.createdAt));

  return rows.map((r) => ({ ...r, kind: r.kind as NoteKind }));
}

/** True when a note with this id has at least one entry. */
export async function noteExists(db: Db, noteId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pilotNotes.id })
    .from(pilotNotes)
    .where(eq(pilotNotes.noteId, noteId))
    .limit(1);
  return row !== undefined;
}

export interface AppendEntryInput {
  id: string;
  noteId: string;
  kind: NoteKind;
  title: string | null;
  body: string;
  category: string | null;
  author: string;
  createdAt: Date;
}

/** The one write. Insert only — there is deliberately no update or delete. */
export async function appendPilotEntry(db: Db, entry: AppendEntryInput): Promise<void> {
  await db.insert(pilotNotes).values(entry);
}
