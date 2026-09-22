import { describe, it, expect } from "vitest";
import {
  CHANNELS, STATUSES, TERMINAL_STATUSES,
  isSameSlot, findDuplicate, planUpdate, canRemove,
  type CalendarEntryFacts,
} from "@/domain/calendar/writes";

const entry = (over: Partial<CalendarEntryFacts> = {}): CalendarEntryFacts => ({
  id: "e1",
  date: new Date("2026-10-01T00:00:00Z"),
  channel: "Email",
  title: "October launch",
  status: "planned",
  notes: null,
  ...over,
});

describe("the vocabulary", () => {
  it("knows the channels the schema documents", () => {
    expect(CHANNELS).toEqual(["Email", "SMS", "Ad", "Reel", "Post", "Story", "Blog"]);
  });

  it("knows the statuses the schema documents", () => {
    expect(STATUSES).toEqual(["idea", "planned", "scheduled", "sent", "posted", "skipped"]);
  });

  // skipped is a plan decision and reversible; sent and posted are not.
  it("treats only sent and posted as records of what happened", () => {
    expect(TERMINAL_STATUSES).toEqual(["sent", "posted"]);
    expect(TERMINAL_STATUSES).not.toContain("skipped");
  });
});

describe("isSameSlot", () => {
  const slot = { date: new Date("2026-10-01T09:00:00Z"), channel: "Email", title: "October launch" };

  it("matches the same entry planned again", () => {
    expect(isSameSlot(slot, { ...slot })).toBe(true);
  });

  // An agent replanning a week would otherwise double every entry, and a
  // calendar with two of everything reads as a busy week rather than a bug.
  it("ignores the time of day, since the calendar plans by day", () => {
    expect(isSameSlot(slot, { ...slot, date: new Date("2026-10-01T17:30:00Z") })).toBe(true);
  });

  it("ignores case and surrounding space in the title", () => {
    expect(isSameSlot(slot, { ...slot, title: "  OCTOBER LAUNCH " })).toBe(true);
  });

  it("does not match a different day", () => {
    expect(isSameSlot(slot, { ...slot, date: new Date("2026-10-02T09:00:00Z") })).toBe(false);
  });

  it("does not match a different channel", () => {
    expect(isSameSlot(slot, { ...slot, channel: "SMS" })).toBe(false);
  });

  it("does not match a genuinely different title", () => {
    expect(isSameSlot(slot, { ...slot, title: "November launch" })).toBe(false);
  });
});

describe("findDuplicate", () => {
  it("finds the entry that already occupies the slot", () => {
    const found = findDuplicate([entry()], {
      date: new Date("2026-10-01T18:00:00Z"), channel: "Email", title: "October launch",
    });
    expect(found?.id).toBe("e1");
  });

  it("returns null when the slot is free", () => {
    expect(findDuplicate([entry()], {
      date: new Date("2026-10-05T00:00:00Z"), channel: "Email", title: "October launch",
    })).toBeNull();
  });

  it("returns null against an empty calendar", () => {
    expect(findDuplicate([], { date: new Date(), channel: "Email", title: "x" })).toBeNull();
  });
});

describe("planUpdate", () => {
  it("returns only the fields that actually differ", () => {
    const plan = planUpdate(entry(), { title: "New title", channel: "Email" });
    expect(plan.ok && plan.value).toEqual({ title: "New title" });
  });

  // A call that changes nothing and a call that wrote successfully need
  // opposite responses from a caller deciding whether to retry.
  it("refuses an update with no fields at all", () => {
    const plan = planUpdate(entry(), {});
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/at least one/);
  });

  it("refuses an update where every value already matches", () => {
    const plan = planUpdate(entry(), { title: "October launch", status: "planned" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/nothing to change/i);
  });

  it("allows a normal status advance", () => {
    const plan = planUpdate(entry(), { status: "scheduled" });
    expect(plan.ok && plan.value).toEqual({ status: "scheduled" });
  });

  it("allows marking an entry sent", () => {
    expect(planUpdate(entry(), { status: "sent" }).ok).toBe(true);
  });

  // Retitling something already sent makes the calendar disagree with what the
  // audience received, and nothing downstream would flag it.
  it("refuses to retitle an entry that has been sent", () => {
    const plan = planUpdate(entry({ status: "sent" }), { title: "Rewritten" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/records what went out/);
  });

  it("refuses to move the date of an entry that has been posted", () => {
    expect(planUpdate(entry({ status: "posted" }), { date: new Date("2026-11-01T00:00:00Z") }).ok)
      .toBe(false);
  });

  // Annotating history is not rewriting it.
  it("allows a note on an entry that has been sent", () => {
    const plan = planUpdate(entry({ status: "sent" }), { notes: "Subject line changed on the day" });
    expect(plan.ok && plan.value).toEqual({ notes: "Subject line changed on the day" });
  });

  it("names every disallowed field, not just the first", () => {
    const plan = planUpdate(entry({ status: "sent" }), { title: "x", channel: "SMS" });
    if (!plan.ok) {
      expect(plan.error).toContain("title");
      expect(plan.error).toContain("channel");
    }
  });

  // Without a correction path, an entry wrongly marked sent could never be
  // fixed, and protecting history would have made a data-entry error permanent.
  it("allows moving a sent entry back when correcting, with a reason", () => {
    const plan = planUpdate(
      entry({ status: "sent" }),
      { status: "planned", notes: "marked sent by mistake; never went out" },
      { correction: true },
    );
    expect(plan.ok && plan.value).toEqual({
      status: "planned", notes: "marked sent by mistake; never went out",
    });
  });

  // A correction with no reason changes the calendar leaving no record of who
  // decided it had not happened.
  it("refuses a correction with no note", () => {
    const plan = planUpdate(entry({ status: "sent" }), { status: "planned" }, { correction: true });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/needs a note/);
  });

  it("refuses a correction whose note is only whitespace", () => {
    const plan = planUpdate(entry({ status: "sent" }), { status: "planned", notes: "   " }, { correction: true });
    expect(plan.ok).toBe(false);
  });

  // The way back to editing content is two deliberate steps, not one flag.
  it("still refuses to retitle a sent entry even when correcting", () => {
    const plan = planUpdate(
      entry({ status: "sent" }),
      { title: "Rewritten", notes: "because" },
      { correction: true },
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/Set the status back first/);
  });

  it("does not need a correction flag for a non-terminal entry", () => {
    expect(planUpdate(entry({ status: "planned" }), { status: "idea" }).ok).toBe(true);
  });

  // skipped is reversible: the decision not to send can be taken back.
  it("allows editing an entry that was skipped", () => {
    expect(planUpdate(entry({ status: "skipped" }), { status: "planned" }).ok).toBe(true);
  });

  it("rejects a channel the calendar does not know", () => {
    const plan = planUpdate(entry(), { channel: "Carrier Pigeon" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/Unknown channel/);
  });

  it("rejects a status the calendar does not know", () => {
    expect(planUpdate(entry(), { status: "publishedish" }).ok).toBe(false);
  });

  it("rejects a blank title", () => {
    expect(planUpdate(entry(), { title: "   " }).ok).toBe(false);
  });

  it("allows clearing notes back to null", () => {
    const plan = planUpdate(entry({ notes: "old" }), { notes: null });
    expect(plan.ok && plan.value).toEqual({ notes: null });
  });
});

describe("canRemove", () => {
  it("allows removing a planned entry", () => {
    expect(canRemove(entry()).ok).toBe(true);
  });

  it("allows removing an idea", () => {
    expect(canRemove(entry({ status: "idea" })).ok).toBe(true);
  });

  // Deleting a sent entry does not un-send it; it deletes the only record that
  // it happened, and next week's report is then computed over a calendar that
  // disagrees with what the audience received.
  it("refuses to remove an entry that was sent", () => {
    const plan = canRemove(entry({ status: "sent" }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/only record that it did/);
  });

  it("refuses to remove an entry that was posted", () => {
    expect(canRemove(entry({ status: "posted" })).ok).toBe(false);
  });

  it("points at skipped as the alternative when it did not go out", () => {
    const plan = canRemove(entry({ status: "sent" }));
    if (!plan.ok) expect(plan.error).toMatch(/skipped/);
  });
});
