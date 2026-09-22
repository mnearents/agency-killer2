/**
 * Calendar writes, and the rules that stop an agent quietly rewriting history
 * (#28).
 *
 * The marketing calendar is shared with Tara, who does not read code and will
 * not diff a row. So the constraints here are about what she would notice if
 * it went wrong, not about database integrity:
 *
 * - **An entry Claude wrote is marked as such.** `aiSuggested` already exists
 *   for this; every write from the MCP sets it. An AI-planned week and a week
 *   Tara planned must not be indistinguishable in the thing she is looking at.
 * - **What has already gone out is not editable.** Once an entry is `sent` or
 *   `posted` it is a record of what happened, not a plan. Retitling it makes
 *   the calendar disagree with the world, and nothing would ever flag that.
 *   Notes stay editable, because annotating history is not rewriting it.
 * - **The same thing is not planned twice.** An agent asked to plan a week
 *   twice would otherwise double every entry, and a calendar with two of
 *   everything reads as a busy week rather than a bug.
 *
 * Pure functions only — no database and no clock.
 */

/** The channels the calendar knows about, as the schema comment lists them. */
export const CHANNELS = ["Email", "SMS", "Ad", "Reel", "Post", "Story", "Blog"] as const;

/** idea -> planned -> scheduled -> sent | posted | skipped. */
export const STATUSES = ["idea", "planned", "scheduled", "sent", "posted", "skipped"] as const;

/**
 * Statuses that record something that has happened.
 *
 * `skipped` is deliberately NOT terminal: a decision not to send is a plan
 * decision and can be reversed before the date. `sent` and `posted` cannot —
 * the message is out.
 */
export const TERMINAL_STATUSES: readonly string[] = ["sent", "posted"];

export interface CalendarEntryFacts {
  id: string;
  date: Date;
  channel: string;
  title: string;
  status: string;
  notes: string | null;
}

export interface EntryChanges {
  date?: Date;
  channel?: string;
  title?: string;
  status?: string;
  notes?: string | null;
}

/** Same day, same channel, same title — the shape of an accidental re-plan. */
export function isSameSlot(a: { date: Date; channel: string; title: string }, b: { date: Date; channel: string; title: string }): boolean {
  return (
    a.date.toISOString().slice(0, 10) === b.date.toISOString().slice(0, 10) &&
    a.channel.toLowerCase() === b.channel.toLowerCase() &&
    a.title.trim().toLowerCase() === b.title.trim().toLowerCase()
  );
}

export function findDuplicate(
  existing: CalendarEntryFacts[],
  candidate: { date: Date; channel: string; title: string },
): CalendarEntryFacts | null {
  return existing.find((e) => isSameSlot(e, candidate)) ?? null;
}

export type WritePlan<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * What an update is allowed to change.
 *
 * Returns the fields that would actually differ, so a call that changes
 * nothing is an error rather than a success that wrote nothing — those need
 * opposite responses from a caller deciding whether to retry.
 */
export interface UpdateOptions {
  /**
   * Correcting an entry that was marked sent or posted by mistake.
   *
   * Without this, an entry wrongly marked `sent` could never be fixed, and
   * protecting history would have made a data-entry error permanent. It
   * requires a note saying why, so a correction always leaves a reason behind
   * — and it still cannot touch the date, channel or title, so the way back to
   * editing those is two deliberate steps rather than one.
   */
  correction?: boolean;
}

export function planUpdate(
  existing: CalendarEntryFacts,
  changes: EntryChanges,
  options: UpdateOptions = {},
): WritePlan<EntryChanges> {
  const requested = Object.entries(changes).filter(([, v]) => v !== undefined);
  if (requested.length === 0) {
    return { ok: false, error: "No fields to change. Pass at least one of date, channel, title, status or notes." };
  }

  if (TERMINAL_STATUSES.includes(existing.status)) {
    const editable = options.correction ? ["notes", "status"] : ["notes"];
    const disallowed = requested.map(([k]) => k).filter((k) => !editable.includes(k));
    if (disallowed.length > 0) {
      return {
        ok: false,
        error:
          `Entry ${existing.id} is ${existing.status}, so it records what went out rather than what is planned. ` +
          `Only ${editable.join(" and ")} can change; ${disallowed.join(", ")} cannot. ` +
          (options.correction
            ? `Set the status back first, then change those in a second call.`
            : `If it went out differently from the plan, add a note saying so. If it never went out at all, ` +
              `pass correction with a note explaining why.`),
      };
    }
    if (options.correction && (changes.notes === undefined || (changes.notes ?? "").trim() === "")) {
      return {
        ok: false,
        error:
          `A correction to a ${existing.status} entry needs a note saying why it was not actually ${existing.status}. ` +
          `Without one the calendar would change with no record of who decided it had not happened.`,
      };
    }
  }

  if (changes.channel !== undefined && !CHANNELS.includes(changes.channel as typeof CHANNELS[number])) {
    return { ok: false, error: `Unknown channel "${changes.channel}". Known: ${CHANNELS.join(", ")}.` };
  }
  if (changes.status !== undefined && !STATUSES.includes(changes.status as typeof STATUSES[number])) {
    return { ok: false, error: `Unknown status "${changes.status}". Known: ${STATUSES.join(", ")}.` };
  }
  if (changes.title !== undefined && changes.title.trim() === "") {
    return { ok: false, error: "Title cannot be blank." };
  }

  // Only the fields that actually differ.
  const effective: EntryChanges = {};
  if (changes.date !== undefined && changes.date.getTime() !== existing.date.getTime()) {
    effective.date = changes.date;
  }
  if (changes.channel !== undefined && changes.channel !== existing.channel) effective.channel = changes.channel;
  if (changes.title !== undefined && changes.title !== existing.title) effective.title = changes.title;
  if (changes.status !== undefined && changes.status !== existing.status) effective.status = changes.status;
  if (changes.notes !== undefined && changes.notes !== existing.notes) effective.notes = changes.notes;

  if (Object.keys(effective).length === 0) {
    return { ok: false, error: "Every field already has that value — nothing to change." };
  }
  return { ok: true, value: effective };
}

/**
 * Whether an entry can be removed.
 *
 * Deleting something already sent does not un-send it; it deletes the only
 * record that it happened, and next week's report is then computed over a
 * calendar that disagrees with what the audience received.
 */
export function canRemove(existing: CalendarEntryFacts): WritePlan<CalendarEntryFacts> {
  if (TERMINAL_STATUSES.includes(existing.status)) {
    return {
      ok: false,
      error:
        `Entry ${existing.id} is ${existing.status} — it records something that went out, and deleting it ` +
        `would remove the only record that it did. Mark it skipped only if it did NOT go out.`,
    };
  }
  return { ok: true, value: existing };
}
