import { describe, it, expect } from "vitest";
import {
  foldNotes,
  validateEntry,
  renderMarkdown,
  NOTE_KINDS,
  type PilotEntry,
} from "@/domain/pilot/notes";

const at = (iso: string) => new Date(iso);

function entry(overrides: Partial<PilotEntry> & Pick<PilotEntry, "id" | "noteId">): PilotEntry {
  return {
    kind: "open",
    title: "A note",
    body: "Something happened.",
    category: null,
    author: "claude",
    createdAt: at("2026-09-05T10:00:00Z"),
    ...overrides,
  };
}

describe("foldNotes: deriving note state from an append-only log", () => {
  it("treats an opening entry as an open note", () => {
    const notes = foldNotes([entry({ id: "1", noteId: "1" })]);

    expect(notes).toHaveLength(1);
    expect(notes[0].noteId).toBe("1");
    expect(notes[0].status).toBe("open");
    expect(notes[0].title).toBe("A note");
  });

  it("closes a note once a resolution is appended", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1" }),
      entry({ id: "2", noteId: "1", kind: "resolution", title: null, body: "Fixed in Seal." }),
    ]);

    expect(notes[0].status).toBe("closed");
    expect(notes[0].resolution).toBe("Fixed in Seal.");
  });

  // A comment is context, not a decision. If it closed the note, an agent
  // adding a detail would silently retire something still outstanding.
  it("leaves a note open when a comment is appended", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1" }),
      entry({ id: "2", noteId: "1", kind: "comment", title: null, body: "Still happening." }),
    ]);

    expect(notes[0].status).toBe("open");
    expect(notes[0].entries).toHaveLength(2);
  });

  // Reopening has to be possible, or a wrongly-closed note is unfixable in an
  // append-only table.
  it("reopens a note when a later entry opens it again", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1", createdAt: at("2026-09-01T10:00:00Z") }),
      entry({
        id: "2",
        noteId: "1",
        kind: "resolution",
        title: null,
        body: "Thought it was fixed.",
        createdAt: at("2026-09-02T10:00:00Z"),
      }),
      entry({
        id: "3",
        noteId: "1",
        kind: "open",
        title: null,
        body: "Came back.",
        createdAt: at("2026-09-03T10:00:00Z"),
      }),
    ]);

    expect(notes[0].status).toBe("open");
  });

  // Rows come back in whatever order the database chose. Folding them in that
  // order would let an out-of-order read decide a note's status.
  it("folds in timestamp order regardless of input order", () => {
    const resolution = entry({
      id: "2",
      noteId: "1",
      kind: "resolution",
      title: null,
      body: "Done.",
      createdAt: at("2026-09-02T10:00:00Z"),
    });
    const opened = entry({ id: "1", noteId: "1", createdAt: at("2026-09-01T10:00:00Z") });

    expect(foldNotes([resolution, opened])[0].status).toBe("closed");
    expect(foldNotes([opened, resolution])[0].status).toBe("closed");
  });

  it("keeps the opening title when later entries carry none", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1", title: "MRR looks wrong" }),
      entry({ id: "2", noteId: "1", kind: "comment", title: null, body: "more" }),
    ]);

    expect(notes[0].title).toBe("MRR looks wrong");
  });

  it("groups entries by note and reports each separately", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1", title: "First" }),
      entry({ id: "2", noteId: "2", title: "Second" }),
      entry({ id: "3", noteId: "2", kind: "resolution", title: null, body: "done" }),
    ]);

    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.noteId === "1")!.status).toBe("open");
    expect(notes.find((n) => n.noteId === "2")!.status).toBe("closed");
  });

  it("reports last activity as the newest entry, not the opening one", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1", createdAt: at("2026-09-01T10:00:00Z") }),
      entry({
        id: "2",
        noteId: "1",
        kind: "comment",
        title: null,
        body: "later",
        createdAt: at("2026-09-04T10:00:00Z"),
      }),
    ]);

    expect(notes[0].openedAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(notes[0].lastActivityAt.toISOString()).toBe("2026-09-04T10:00:00.000Z");
  });

  // An orphan means a write referenced a note that does not exist. Silently
  // promoting it to a note would invent one; dropping it would hide the write.
  it("surfaces entries whose note was never opened rather than inventing one", () => {
    const notes = foldNotes([
      entry({ id: "2", noteId: "missing", kind: "comment", title: null, body: "orphan" }),
    ]);

    expect(notes).toHaveLength(1);
    expect(notes[0].status).toBe("orphaned");
    expect(notes[0].title).toMatch(/never opened/i);
  });

  it("returns nothing for an empty log rather than throwing", () => {
    expect(foldNotes([])).toEqual([]);
  });
});

describe("validateEntry: the only write path on the server", () => {
  const valid = {
    kind: "open" as const,
    title: "Something",
    body: "Detail",
    category: "subscriptions",
    author: "claude",
  };

  it("accepts a well-formed opening entry", () => {
    expect(validateEntry(valid).ok).toBe(true);
  });

  it("rejects an empty body", () => {
    const result = validateEntry({ ...valid, body: "   " });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/body/i);
  });

  // Without a title an open note is unreadable in a list, and the export has
  // nothing to head the section with.
  it("requires a title when opening a note", () => {
    const result = validateEntry({ ...valid, kind: "open", title: null, noteId: null });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/title/i);
  });

  it("requires a noteId when appending a comment or resolution", () => {
    for (const kind of ["comment", "resolution"] as const) {
      const result = validateEntry({ ...valid, kind, noteId: null });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toMatch(/noteId/i);
    }
  });

  it("rejects a kind outside the known set", () => {
    const result = validateEntry({ ...valid, kind: "delete" as never });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/kind/i);
  });

  // A model can generate unbounded text. An unbounded note is a way to make
  // the export unreadable and the table expensive.
  it("rejects a body beyond the length cap", () => {
    const result = validateEntry({ ...valid, body: "x".repeat(20_001) });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/too long/i);
  });

  it("rejects an empty author so every entry is attributable", () => {
    const result = validateEntry({ ...valid, author: "" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/author/i);
  });

  it("names every kind it accepts", () => {
    expect([...NOTE_KINDS].sort()).toEqual(["comment", "open", "resolution"]);
  });
});

describe("renderMarkdown", () => {
  it("renders a note with its title, status and entries", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1", title: "MRR looks wrong", category: "subscriptions" }),
      entry({ id: "2", noteId: "1", kind: "comment", title: null, body: "Checked the anomalies." }),
    ]);

    const md = renderMarkdown(notes, at("2026-09-05T12:00:00Z"));

    expect(md).toContain("# Pilot notes");
    expect(md).toContain("MRR looks wrong");
    expect(md).toContain("subscriptions");
    expect(md).toContain("Checked the anomalies.");
  });

  // An empty export that looks like a heading with nothing under it reads as
  // "no problems". It should say which it is.
  it("says explicitly when there is nothing to export", () => {
    const md = renderMarkdown([], at("2026-09-05T12:00:00Z"));
    expect(md).toMatch(/no notes/i);
  });

  it("separates open notes from closed ones", () => {
    const notes = foldNotes([
      entry({ id: "1", noteId: "1", title: "Still open" }),
      entry({ id: "2", noteId: "2", title: "Done one" }),
      entry({ id: "3", noteId: "2", kind: "resolution", title: null, body: "fixed" }),
    ]);

    const md = renderMarkdown(notes, at("2026-09-05T12:00:00Z"));
    expect(md.indexOf("Still open")).toBeLessThan(md.indexOf("Done one"));
    expect(md).toMatch(/## Open/);
    expect(md).toMatch(/## Closed/);
  });
});
