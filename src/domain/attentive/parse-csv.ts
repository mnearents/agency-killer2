/**
 * Attentive CSV parsers — deterministic parsing of tab-separated
 * export files from Attentive's reporting UI.
 *
 * Attentive has no API, so data comes in as manual CSV exports.
 * Two report types supported:
 * - Campaign Performance: per-day sends, clicks, conversions, revenue
 * - Attributed Revenue: per-day conversion revenue + AOV
 */

export interface CampaignPerformanceRow {
  date: string;
  messageVariant: string;
  hasMedia: boolean;
  delivered: number;
  totalClicks: number;
  totalClickRate: number;
  conversions: number;
  conversionRate: number;
  revenueDollars: number;
  unsubscribes: number;
  unsubscribeRate: number;
}

export interface AttributedRevenueRow {
  date: string;
  conversions: number;
  totalRevenueDollars: number;
  avgOrderValueDollars: number;
}

function parseNum(val: string): number {
  // Strip quotes and commas used as thousands separators
  const cleaned = val.replace(/^"|"$/g, "").replace(/,/g, "").trim();
  const n = Number(cleaned);
  return isNaN(n) ? 0 : n;
}

/**
 * Detect delimiter (tab or comma) and split a CSV line.
 * Handles quoted fields with commas inside them.
 */
function detectDelimiter(header: string): string {
  return header.includes("\t") ? "\t" : ",";
}

function splitCsvLine(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t");

  // Handle quoted CSV fields (commas inside quotes)
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function roundTo(val: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function parseCampaignPerformanceCsv(csv: string): CampaignPerformanceRow[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const delimiter = detectDelimiter(lines[0]);
  const rows: CampaignPerformanceRow[] = [];

  // Skip header (line 0), skip "Total" row, parse data rows
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    const dateVal = cols[0]?.replace(/^"|"$/g, "").trim();

    // Skip the aggregate "Total" row
    if (!dateVal || dateVal === "Total") continue;

    rows.push({
      date: dateVal,
      messageVariant: cols[1]?.replace(/^"|"$/g, "").trim() ?? "",
      hasMedia: cols[2]?.replace(/^"|"$/g, "").trim().toUpperCase() === "TRUE",
      delivered: parseNum(cols[3] ?? "0"),
      totalClicks: parseNum(cols[4] ?? "0"),
      totalClickRate: parseNum(cols[5] ?? "0"),
      conversions: parseNum(cols[6] ?? "0"),
      conversionRate: parseNum(cols[7] ?? "0"),
      revenueDollars: roundTo(parseNum(cols[8] ?? "0"), 2),
      unsubscribes: parseNum(cols[9] ?? "0"),
      unsubscribeRate: parseNum(cols[10] ?? "0"),
    });
  }

  return rows;
}

export function parseAttributedRevenueCsv(csv: string): AttributedRevenueRow[] {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const delimiter = detectDelimiter(lines[0]);
  const rows: AttributedRevenueRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], delimiter);
    const dateVal = cols[0]?.replace(/^"|"$/g, "").trim();

    if (!dateVal || dateVal === "Total") continue;

    rows.push({
      date: dateVal,
      conversions: parseNum(cols[1] ?? "0"),
      totalRevenueDollars: roundTo(parseNum(cols[2] ?? "0"), 2),
      avgOrderValueDollars: roundTo(parseNum(cols[3] ?? "0"), 2),
    });
  }

  return rows;
}

/**
 * ─── Campaign, segment and journey level (#23) ────────────────────────
 *
 * The two parsers above read columns by POSITION, which is safe only because
 * their reports are frozen. The four reports below have between 6 and 27
 * columns in different orders, and Attentive adds columns over time — "Text
 * ROAS" and "Email ROAS" are both tagged New in the UI today.
 *
 * A positional parser pointed at a changed report does not fail. It reads
 * "EMAIL" where it expected a delivered count, gets zero from `parseNum`, and
 * stores it. So these are indexed by header name and throw when a column they
 * need is absent — a missing column is a changed report, and a changed report
 * read as zeroes is worse than no report.
 *
 * ## Blank is not zero, except when it is
 *
 * Attentive leaves a cell empty rather than writing 0:
 *
 *   a COUNT that is blank    — nothing happened. Zero.
 *   a RATE or AVERAGE blank  — the denominator was zero. Undefined, not zero.
 *
 * An average order value of 0 says the orders were free; null says there were
 * no orders. The second is true and the first is quotable.
 */

/** Every export opens with an aggregate row. These are the names it uses. */
const AGGREGATE_ROW_LABELS = new Set(["Total", "Overall Performance"]);

interface Table {
  header: string[];
  rows: string[][];
  delimiter: string;
}

function readTable(csv: string): Table | null {
  // The byte-order mark would otherwise make the first header unfindable by
  // name, and every date would read as undefined.
  const text = csv.replace(/^﻿/, "").trim();
  if (!text) return null;

  const lines = text.split("\n");
  if (lines.length < 2) return null;

  const delimiter = detectDelimiter(lines[0]);
  const clean = (v: string) => v.replace(/^"|"$/g, "").trim();

  return {
    header: splitCsvLine(lines[0], delimiter).map(clean),
    rows: lines.slice(1).map((l) => splitCsvLine(l, delimiter).map(clean)),
    delimiter,
  };
}

/**
 * A reader bound to one report's header.
 *
 * `require` collects every missing column before throwing, so a changed report
 * is diagnosed in one run rather than one column at a time.
 */
function columnReader(table: Table, reportName: string, required: string[]) {
  const index = new Map(table.header.map((h, i) => [h, i]));
  const missing = required.filter((c) => !index.has(c));
  if (missing.length > 0) {
    throw new Error(`${reportName} is missing columns: ${missing.join(", ")}`);
  }

  const raw = (row: string[], column: string): string => {
    const i = index.get(column);
    return i === undefined ? "" : row[i] ?? "";
  };

  return {
    text: (row: string[], column: string) => raw(row, column),
    /** Blank means nothing happened. */
    count: (row: string[], column: string) => (raw(row, column) === "" ? 0 : parseNum(raw(row, column))),
    /** Blank means no denominator — null, never 0. */
    ratio: (row: string[], column: string) => {
      const v = raw(row, column);
      return v === "" ? null : parseNum(v);
    },
    /** Dollars in the export; integer cents everywhere inside. */
    cents: (row: string[], column: string) => {
      const v = raw(row, column);
      return v === "" ? 0 : Math.round(parseNum(v) * 100);
    },
    /** Null when there were no orders behind the average. */
    centsOrNull: (row: string[], column: string) => {
      const v = raw(row, column);
      return v === "" ? null : Math.round(parseNum(v) * 100);
    },
    bool: (row: string[], column: string) => raw(row, column).toUpperCase() === "TRUE",
  };
}

/** Data rows only: no header, no aggregate row, no trailing blank. */
function dataRows(table: Table, dateColumnIndex = 0): string[][] {
  return table.rows.filter((r) => {
    const first = r[dateColumnIndex] ?? "";
    return first !== "" && !AGGREGATE_ROW_LABELS.has(first);
  });
}

export interface CampaignMessageRow {
  date: string;
  campaign: string;
  message: string;
  messageVariant: string;
  channel: string;
  hasMedia: boolean;
  delivered: number;
  emailSends: number;
  emailUniqueOpens: number;
  emailUniqueClicks: number;
  totalClicks: number;
  conversions: number;
  revenueCents: number;
  avgOrderValueCents: number | null;
  unsubscribes: number;
  emailHardBounces: number;
}

export function parseCampaignMessageCsv(csv: string): CampaignMessageRow[] {
  const table = readTable(csv);
  if (!table) return [];

  const c = columnReader(table, "Campaign message report", [
    "Message Send Date",
    "Campaign",
    "Message",
    "Message Channel",
    "Delivered",
    "Conversions",
    "Revenue ($ USD)",
    "Unsubscribes",
  ]);

  return dataRows(table).map((r) => ({
    date: c.text(r, "Message Send Date"),
    campaign: c.text(r, "Campaign"),
    message: c.text(r, "Message"),
    messageVariant: c.text(r, "Message Variant"),
    channel: c.text(r, "Message Channel"),
    hasMedia: c.bool(r, "Has Media"),
    delivered: c.count(r, "Delivered"),
    emailSends: c.count(r, "Email Sends"),
    emailUniqueOpens: c.count(r, "Email Unique Opens"),
    emailUniqueClicks: c.count(r, "Email Unique Clicks"),
    totalClicks: c.count(r, "Total Clicks"),
    conversions: c.count(r, "Conversions"),
    revenueCents: c.cents(r, "Revenue ($ USD)"),
    avgOrderValueCents: c.centsOrNull(r, "Average Order Value ($ USD)"),
    unsubscribes: c.count(r, "Unsubscribes"),
    emailHardBounces: c.count(r, "Email Hard Bounces"),
  }));
}

export interface CampaignSegmentRow {
  date: string;
  message: string;
  segment: string;
  channel: string;
  delivered: number;
  totalClicks: number;
  conversions: number;
  revenueCents: number;
  unsubscribes: number;
}

export function parseCampaignSegmentCsv(csv: string): CampaignSegmentRow[] {
  const table = readTable(csv);
  if (!table) return [];

  const c = columnReader(table, "Campaign performance by segment report", [
    "Message Send Date",
    "Message",
    "Segment",
    "Message Channel",
    "Delivered",
    "Conversions",
    "Revenue ($ USD)",
    "Unsubscribes",
  ]);

  return dataRows(table).map((r) => ({
    date: c.text(r, "Message Send Date"),
    message: c.text(r, "Message"),
    segment: c.text(r, "Segment"),
    channel: c.text(r, "Message Channel"),
    delivered: c.count(r, "Delivered"),
    totalClicks: c.count(r, "Total Clicks"),
    conversions: c.count(r, "Conversions"),
    revenueCents: c.cents(r, "Revenue ($ USD)"),
    unsubscribes: c.count(r, "Unsubscribes"),
  }));
}

export interface JourneyMessageRow {
  date: string;
  journeyName: string;
  triggerName: string;
  message: string;
  channel: string;
  delivered: number;
  totalClicks: number;
  conversions: number;
  revenueCents: number;
  avgOrderValueCents: number | null;
  unsubscribes: number;
}

export function parseJourneyMessageCsv(csv: string): JourneyMessageRow[] {
  const table = readTable(csv);
  if (!table) return [];

  const c = columnReader(table, "Journey message-level report", [
    "Send Date",
    "Journey Name",
    "Message",
    "Channel",
    "Delivered",
    "Conversions",
    "Revenue ($ USD)",
    "Unsubscribes",
  ]);

  return dataRows(table).map((r) => ({
    date: c.text(r, "Send Date"),
    journeyName: c.text(r, "Journey Name"),
    triggerName: c.text(r, "Trigger Name"),
    message: c.text(r, "Message"),
    channel: c.text(r, "Channel"),
    delivered: c.count(r, "Delivered"),
    totalClicks: c.count(r, "Total Clicks"),
    conversions: c.count(r, "Conversions"),
    revenueCents: c.cents(r, "Revenue ($ USD)"),
    avgOrderValueCents: c.centsOrNull(r, "Average Order Value ($ USD)"),
    unsubscribes: c.count(r, "Unsubscribes"),
  }));
}

export interface MessageCostRow {
  date: string;
  campaignCostCents: number;
  automatedSendCostCents: number;
  receivedCostCents: number;
  carrierFeesCents: number;
  /** As reported. The rounded parts do not always add to it. */
  totalCents: number;
}

export function parseMessageCostCsv(csv: string): MessageCostRow[] {
  const table = readTable(csv);
  if (!table) return [];

  const c = columnReader(table, "Daily message cost report", [
    "Send Date",
    "Total ($ USD)",
  ]);

  return dataRows(table).map((r) => ({
    date: c.text(r, "Send Date"),
    campaignCostCents: c.cents(r, "Campaign Cost ($ USD)"),
    automatedSendCostCents: c.cents(r, "Automated Send Cost ($ USD)"),
    receivedCostCents: c.cents(r, "Received Cost ($ USD)"),
    carrierFeesCents: c.cents(r, "Carrier Fees ($ USD)"),
    // Stored as reported rather than summed: rounded parts disagree with it.
    totalCents: c.cents(r, "Total ($ USD)"),
  }));
}
