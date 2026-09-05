/**
 * Pilot notes — an append-only log of observations, and the fold that turns it
 * into readable notes.
 *
 * The MCP server is otherwise read-only. This is the one thing it can write,
 * which shapes the whole design: entries are appended and never updated or
 * deleted, so the worst a mistaken write can do is add something wrong, which
 * stays visible and is corrected by appending again. A mutable `status` column
 * would instead let one bad write erase the reasoning behind a note with no
 * trace that it had.
 *
 * A note is therefore not a row. It is a `note_id` plus every entry sharing it,
 * folded in time order: `open` creates (and can re-open), `comment` adds
 * context, `resolution` closes.
 *
 * Pure functions only — no database, no clock. The caller supplies both.
 */

export const NOTE_KINDS = ["open", "comment", "resolution"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** `orphaned` is not a state anyone writes; it is what a dangling entry folds to. */
export type NoteStatus = "open" | "closed" | "orphaned";

export interface PilotEntry {
  id: string;
  noteId: string;
  kind: NoteKind;
  /** Carried by the opening entry; null on later ones, which inherit it. */
  title: string | null;
  body: string;
  category: string | null;
  author: string;
  createdAt: Date;
}

export interface PilotNote {
  noteId: string;
  title: string;
  category: string | null;
  status: NoteStatus;
  openedAt: Date;
  lastActivityAt: Date;
  /** Set only when the newest status-bearing entry was a resolution. */
  resolution: string | null;
  /** Every entry, oldest first. The audit trail is the point. */
  entries: PilotEntry[];
}

const MAX_BODY_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 200;

// ─── Folding ──────────────────────────────────────────────────────────

/**
 * Group entries by note and derive each note's current state.
 *
 * Entries are sorted by timestamp rather than trusted in argument order: rows
 * arrive in whatever order the database chose, and folding them in that order
 * would let an incidental ORDER BY decide whether a note reads as open.
 */
export function foldNotes(entries: PilotEntry[]): PilotNote[] {
  const byNote = new Map<string, PilotEntry[]>();
  for (const e of entries) {
    const list = byNote.get(e.noteId);
    if (list) list.push(e);
    else byNote.set(e.noteId, [e]);
  }

  const notes: PilotNote[] = [];
  for (const [noteId, group] of byNote) {
    const ordered = [...group].sort((a, b) => {
      const d = a.createdAt.getTime() - b.createdAt.getTime();
      // Two entries can share a timestamp. Falling back to id keeps the fold
      // deterministic instead of depending on sort stability.
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });

    const opening = ordered.find((e) => e.kind === "open") ?? null;

    // An entry whose note was never opened means a write referenced something
    // that does not exist. Promoting it to a note would invent one that was
    // never written; dropping it would hide a write that did happen. Neither is
    // acceptable on the one table anything can write to, so it is surfaced.
    const status: NoteStatus = opening === null ? "orphaned" : lastStatus(ordered);

    const resolution =
      status === "closed"
        ? (ordered.filter((e) => e.kind === "resolution").at(-1)?.body ?? null)
        : null;

    notes.push({
      noteId,
      title:
        opening?.title ??
        ordered.find((e) => e.title !== null)?.title ??
        `(entry for a note that was never opened: ${noteId})`,
      category: ordered.find((e) => e.category !== null)?.category ?? null,
      status,
      openedAt: (opening ?? ordered[0]).createdAt,
      lastActivityAt: ordered[ordered.length - 1].createdAt,
      resolution,
      entries: ordered,
    });
  }

  // Newest activity first: the thing that changed most recently is the thing
  // most likely to matter.
  return notes.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
}

/**
 * Open or closed, decided by the newest entry that carries a status.
 *
 * Comments deliberately do not count. Re-opening is possible because in an
 * append-only table it is the only way to correct a note closed by mistake.
 */
function lastStatus(ordered: PilotEntry[]): "open" | "closed" {
  const deciding = ordered.filter((e) => e.kind === "open" || e.kind === "resolution").at(-1);
  return deciding?.kind === "resolution" ? "closed" : "open";
}

// ─── Validation ───────────────────────────────────────────────────────

export interface EntryDraft {
  kind: NoteKind;
  title?: string | null;
  body: string;
  category?: string | null;
  author: string;
  /** Required when appending to an existing note; absent when opening one. */
  noteId?: string | null;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/**
 * Fail closed. This runs on the only write path the server exposes, and its
 * caller is a model producing untyped JSON, so anything it cannot confirm is
 * rejected rather than stored in a shape the fold will misread later.
 */
export function validateEntry(draft: EntryDraft): ValidationResult {
  if (!NOTE_KINDS.includes(draft.kind)) {
    return { ok: false, error: `"kind" must be one of: ${NOTE_KINDS.join(", ")}` };
  }

  const body = (draft.body ?? "").trim();
  if (body === "") return { ok: false, error: `"body" cannot be empty` };
  if (body.length > MAX_BODY_LENGTH) {
    return { ok: false, error: `"body" is too long (${body.length} > ${MAX_BODY_LENGTH} characters)` };
  }

  const author = (draft.author ?? "").trim();
  if (author === "") {
    return { ok: false, error: `"author" is required so every entry is attributable` };
  }

  const title = draft.title?.trim() ?? "";
  const noteId = draft.noteId?.trim() ?? "";

  if (draft.kind === "open" && noteId === "" && title === "") {
    return { ok: false, error: `"title" is required when opening a new note` };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `"title" is too long (${title.length} > ${MAX_TITLE_LENGTH} characters)` };
  }

  // A comment or resolution with no note to attach to would fold to an orphan.
  // Rejecting it here means the orphan path only ever catches genuine data
  // damage, never a routine bad argument.
  if ((draft.kind === "comment" || draft.kind === "resolution") && noteId === "") {
    return { ok: false, error: `"noteId" is required to ${draft.kind} an existing note` };
  }

  return { ok: true };
}

// ─── Export ───────────────────────────────────────────────────────────

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Markdown for a human to read — the one place prose is the point. */
export function renderMarkdown(notes: PilotNote[], now: Date): string {
  const header = `# Pilot notes\n\nExported ${now.toISOString()}\n`;

  if (notes.length === 0) {
    // An empty export under a bare heading reads as "everything is fine".
    // Say which it is.
    return `${header}\nNo notes have been recorded.\n`;
  }

  const sections: string[] = [header];

  for (const [heading, status] of [
    ["Open", "open"],
    ["Closed", "closed"],
    ["Orphaned (entries whose note was never opened)", "orphaned"],
  ] as const) {
    const group = notes.filter((n) => n.status === status);
    if (group.length === 0) continue;

    sections.push(`\n## ${heading} (${group.length})\n`);
    for (const note of group) {
      const tag = note.category ? ` \`${note.category}\`` : "";
      sections.push(`\n### ${note.title}${tag}\n`);
      sections.push(
        `*opened ${isoDay(note.openedAt)} · last activity ${isoDay(note.lastActivityAt)} · id ${note.noteId}*\n`
      );
      for (const e of note.entries) {
        const label = e.kind === "open" ? "note" : e.kind;
        sections.push(`\n- **${label}** (${isoDay(e.createdAt)}, ${e.author}): ${e.body}`);
      }
      sections.push("\n");
    }
  }

  return sections.join("");
}
