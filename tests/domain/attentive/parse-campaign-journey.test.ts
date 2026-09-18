/**
 * Parsers for the campaign-, segment- and journey-level Attentive reports
 * (#23), built against real exports rather than a guessed shape.
 *
 * The fixtures in `tests/fixtures/attentive/` are genuine downloads pulled
 * from the reporting UI on 2026-09-18. Nothing here was invented, which
 * matters because the previous parsers read columns by POSITION and the four
 * new reports have between 6 and 27 columns in different orders. A positional
 * parser pointed at the wrong report does not fail — it reads "EMAIL" as a
 * delivered count, gets 0, and stores it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCampaignMessageCsv,
  parseCampaignSegmentCsv,
  parseJourneyMessageCsv,
  parseMessageCostCsv,
} from "@/domain/attentive/parse-csv";

const fixture = (name: string) =>
  readFileSync(join(process.cwd(), "tests/fixtures/attentive", name), "utf-8");

const CAMPAIGN = fixture("campaign-message-performance.csv");
const SEGMENT = fixture("campaign-performance-by-segment.csv");
const JOURNEY = fixture("journey-message-performance.csv");
const COST = fixture("daily-message-cost.csv");

describe("parseCampaignMessageCsv", () => {
  const rows = parseCampaignMessageCsv(CAMPAIGN);

  /**
   * The export's first data row is an aggregate over the whole window, with
   * "Total" where the date goes. Kept, it becomes a campaign with 111,852
   * deliveries and no date — larger than every real campaign combined, and
   * plausible enough to survive a glance.
   */
  it("drops the aggregate Total row", () => {
    expect(rows.every((r) => r.date !== "Total")).toBe(true);
    expect(rows.map((r) => r.date)).not.toContain("");
  });

  it("reads the four real campaigns in the window", () => {
    expect(rows).toHaveLength(4);
  });

  // The whole point of #23: a campaign has a name, and the aggregate did not.
  it("carries the campaign name and the message name separately", () => {
    const sale = rows.find((r) => r.campaign === "2026 Dated Sale")!;
    expect(sale).toBeDefined();
    expect(sale.message).toBe("Email");
    expect(sale.date).toBe("2026-08-19");
  });

  it("reads the performance figures off the right columns", () => {
    const sale = rows.find((r) => r.campaign === "2026 Dated Sale")!;
    expect(sale.channel).toBe("EMAIL");
    expect(sale.delivered).toBe(35998);
    expect(sale.totalClicks).toBe(1035);
    expect(sale.conversions).toBe(29);
    expect(sale.revenueCents).toBe(68348);
  });

  /**
   * #23: "unsubscribes is the one most likely to be treated as optional. It is
   * the cost side of every send." The 2026 Dated Sale earned $683 and cost 159
   * unsubscribes, and only one of those numbers was previously stored per
   * campaign.
   */
  it("carries unsubscribes per campaign", () => {
    const sale = rows.find((r) => r.campaign === "2026 Dated Sale")!;
    expect(sale.unsubscribes).toBe(159);
  });

  it("carries the email engagement columns", () => {
    const sale = rows.find((r) => r.campaign === "2026 Dated Sale")!;
    expect(sale.emailSends).toBe(36096);
    expect(sale.emailUniqueOpens).toBe(19814);
    expect(sale.emailUniqueClicks).toBe(613);
  });

  // Money is integer cents on the way in, dollars only at the MCP boundary.
  it("stores revenue as integer cents", () => {
    const homeschool = rows.find((r) => r.campaign === "Homeschool PDF ManyChat Upload")!;
    expect(homeschool.revenueCents).toBe(5450);
  });
});

/**
 * ─── Blank is not zero, except when it is ─────────────────────────────
 *
 * Attentive leaves a cell empty rather than writing 0, and the right reading
 * depends on what the column is:
 *
 *   a COUNT that is blank      — nothing happened. Zero.
 *   a RATE or AVERAGE blank    — the denominator was zero. Undefined, not zero.
 *
 * An average order value of 0 says the orders were free. Null says there were
 * no orders. Those are different facts and the second one is true.
 */
describe("blank cells", () => {
  const rows = parseJourneyMessageCsv(JOURNEY);

  it("reads a blank conversion count as none", () => {
    const sunset = rows.find((r) => r.message === "List Cleaning Journey Email 2")!;
    expect(sunset).toBeDefined();
    expect(sunset.conversions).toBe(0);
  });

  it("reads a blank average order value as unknown, not as free", () => {
    const sunset = rows.find((r) => r.message === "List Cleaning Journey Email 2")!;
    expect(sunset.avgOrderValueCents).toBeNull();
  });

  it("reads a blank unsubscribe count as none", () => {
    const browse = rows.find((r) => r.message === "Journey Browse Abandoner Email 1")!;
    expect(browse).toBeDefined();
    expect(browse.unsubscribes).toBe(0);
  });

  it("keeps a real average order value", () => {
    const browse = rows.find((r) => r.message === "Journey Browse Abandoner Email 1")!;
    expect(browse.avgOrderValueCents).toBe(1659);
  });
});

describe("parseJourneyMessageCsv", () => {
  const rows = parseJourneyMessageCsv(JOURNEY);

  it("drops the aggregate Total row", () => {
    expect(rows.every((r) => r.date !== "Total")).toBe(true);
  });

  it("parses every data line in the fixture", () => {
    // 60-line fixture: one header, one Total row, 58 journey messages.
    expect(rows).toHaveLength(58);
  });

  /**
   * A journey runs unattended for months, so a message inside one is where
   * silent ongoing loss lives. Naming the journey, the trigger and the message
   * separately is what makes "which step drops people" answerable.
   */
  it("names the journey, the trigger and the message", () => {
    const r = rows.find((x) => x.message === "Journey Browse Abandoner Email 1")!;
    expect(r.journeyName).toBe("Browse Abandonment - Text + Email (1)");
    expect(r.triggerName).toBe("Viewed a product");
    expect(r.channel).toBe("EMAIL");
  });

  it("reads the performance figures", () => {
    const r = rows.find((x) => x.message === "Journey Browse Abandoner Email 1")!;
    expect(r.delivered).toBe(158);
    expect(r.totalClicks).toBe(1);
    expect(r.conversions).toBe(1);
    expect(r.revenueCents).toBe(1659);
  });
});

describe("parseCampaignSegmentCsv", () => {
  const rows = parseCampaignSegmentCsv(SEGMENT);

  // This export says "Overall Performance" where the others say "Total".
  it("drops the aggregate row under its other name", () => {
    expect(rows.every((r) => r.date !== "Overall Performance")).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it("carries the segment a message went to", () => {
    const r = rows.find((x) => x.segment === "Homeschool ManyChat")!;
    expect(r).toBeDefined();
    expect(r.message).toBe("Homeschool PDF Email");
    expect(r.delivered).toBe(143);
    expect(r.unsubscribes).toBe(1);
  });

  it("keeps the whole-list sends too", () => {
    expect(rows.some((r) => r.segment === "All Subscribers")).toBe(true);
  });
});

/**
 * Message cost was not on #23's list and is the cheapest thing in this export.
 * #34 needs it: SMS costs money per send, and a journey's revenue net of its
 * carrier fees is a different number from its revenue.
 */
describe("parseMessageCostCsv", () => {
  const rows = parseMessageCostCsv(COST);

  it("drops the aggregate Total row", () => {
    expect(rows.every((r) => r.date !== "Total")).toBe(true);
  });

  it("splits cost by where it came from", () => {
    const r = rows.find((x) => x.date === "2026-08-19")!;
    expect(r.campaignCostCents).toBe(0);
    expect(r.automatedSendCostCents).toBe(71);
    expect(r.receivedCostCents).toBe(1);
    expect(r.carrierFeesCents).toBe(50);
    expect(r.totalCents).toBe(122);
  });

  /**
   * The parts are stored alongside the total rather than derived from it. They
   * do not always add up to the rounded total, and a total computed from
   * rounded parts would silently disagree with the invoice.
   */
  it("stores the reported total rather than re-adding the parts", () => {
    const r = rows.find((x) => x.date === "2026-08-20")!;
    expect(r.totalCents).toBe(55);
  });
});

/**
 * ─── The BOM, and reading by name ─────────────────────────────────────
 *
 * Every export begins with a UTF-8 byte-order mark, so the first header is
 * "﻿Message Send Date" rather than "Message Send Date". A name-indexed
 * parser that does not strip it fails to find its own first column and reads
 * every date as undefined.
 */
describe("header handling", () => {
  it("finds the first column despite the byte-order mark", () => {
    expect(CAMPAIGN.charCodeAt(0)).toBe(0xfeff);
    expect(parseCampaignMessageCsv(CAMPAIGN)[0].date).toBe("2026-08-19");
  });

  /**
   * Columns are located by header name, not by position. The four reports have
   * between 6 and 27 columns in different orders, and Attentive adds columns
   * over time — "Text ROAS" and "Email ROAS" are both tagged New in the UI
   * today. A positional parser pointed at a changed report does not fail: it
   * reads "EMAIL" as a delivered count, gets zero, and stores it.
   */
  it("refuses a report missing a column it needs, rather than storing zeroes", () => {
    const wrongReport = "Send Date,Conversions,Total Revenue ($ USD)\n2026-08-19,19,433.68\n";
    // Every missing column, named, in one message — a changed report should be
    // diagnosed in one run rather than one column per attempt.
    expect(() => parseCampaignMessageCsv(wrongReport)).toThrow(
      "Campaign message report is missing columns: Message Send Date, Campaign, " +
        "Message, Message Channel, Delivered, Revenue ($ USD), Unsubscribes"
    );
  });

  it("returns nothing for an empty export rather than throwing", () => {
    expect(parseCampaignMessageCsv("")).toEqual([]);
    expect(parseJourneyMessageCsv("   ")).toEqual([]);
  });
});
