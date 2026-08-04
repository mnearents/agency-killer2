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
