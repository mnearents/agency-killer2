import { describe, it, expect } from "vitest";

/**
 * The 2FA message is the whole interface between a scheduled job and a person
 * holding a phone, so its wording is behaviour rather than presentation.
 */
function buildMessage(requestedAt: Date, attempt: number): string {
  const time = requestedAt.toLocaleTimeString("en-US", {
    timeZone: "America/Denver", hour: "numeric", minute: "2-digit", second: "2-digit",
  });
  const preamble = attempt > 1
    ? `That code did not work — Attentive has sent a new one (attempt ${attempt}). `
    : "Attentive needs a 2FA code to finish logging in. ";
  return `${preamble}*Use the code that arrives at or after ${time} MT and ignore any earlier one* — ` +
    `Attentive sends two with different values and only the newer works. Reply here with the 6 digits.`;
}

describe("the 2FA Slack message", () => {
  const at = new Date("2026-09-24T15:03:15Z");

  // Two codes arrive with different values and only the newer works. Without
  // a timestamp there is no way to tell them apart from the phone.
  it("names the time to go by", () => {
    expect(buildMessage(at, 1)).toMatch(/9:03:15\s?AM MT/);
  });

  it("says to ignore the earlier code", () => {
    expect(buildMessage(at, 1)).toMatch(/ignore any earlier one/);
  });

  it("explains why there are two, so the instruction is followable", () => {
    expect(buildMessage(at, 1)).toMatch(/sends two with different values/);
  });

  // A rejected code is the normal outcome of sending the older one, and the
  // retry has to say that rather than repeating the first message.
  it("says the previous code failed on a retry", () => {
    expect(buildMessage(at, 2)).toMatch(/did not work/);
    expect(buildMessage(at, 2)).toMatch(/attempt 2/);
  });

  it("does not claim a failure on the first ask", () => {
    expect(buildMessage(at, 1)).not.toMatch(/did not work/);
  });

  it("carries the new timestamp on a retry, since a fresh code was sent", () => {
    const later = new Date("2026-09-24T15:09:40Z");
    expect(buildMessage(later, 2)).toMatch(/9:09:40\s?AM MT/);
  });
});
