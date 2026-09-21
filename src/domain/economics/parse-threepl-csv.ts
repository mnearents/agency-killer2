/**
 * Parses the 3PL charge ledger (#34).
 *
 * The export is one row per **charge**, not per shipment. Each row carries the
 * charge itself plus context from whichever entity produced it — a shipment, a
 * product, a storage bin, a return, a bill. Irrelevant blocks are blank, so a
 * storage row has no tracking number and a shipping row has no bin type.
 *
 * It is parsed at that grain and stored that way. Splitting it into shipments,
 * storage and returns on the way in would mean a charge category nobody
 * anticipated is silently dropped by an importer that reports success; kept
 * whole, a new category arrives as rows with an unfamiliar `category` that
 * queries can find.
 *
 * Money is parsed to cents here and never crosses a boundary as dollars.
 */

/** The two columns that may carry a merchant order reference. */
export const ORDER_COLUMNS = ["Order # (shipment)", "ORDER NUMBER"] as const;

/** Shopify order names are `RH123456`, six of 54,265 with an `-EXC` suffix. */
export const ORDER_NUMBER_PATTERN = /^RH\d+(-EXC)?$/i;

/**
 * Columns mapped onto table fields. Anything not here is kept in `extra` and
 * reported — never dropped. `F1` in the observed header is exactly the kind of
 * unexplained trailing column that must not decide by itself that it is noise.
 */
export const KNOWN_COLUMNS: Record<string, string> = {
  "Date (charge)": "chargeDate",
  "Category (charge)": "category",
  "Fee (charge)": "fee",
  "Type (charge)": "type",
  "Label (charge)": "label",
  "Description (charge)": "description",
  "Unit rate (charge)": "unitRate",
  "Quantity (charge)": "quantity",
  "Total (charge)": "total",
  "Order # (shipment)": "shipmentOrderNumber",
  "Order date (shipment)": "orderDate",
  "Tracking # (shipment)": "trackingNumber",
  "Method (shipment)": "method",
  "Box (shipment)": "box",
  "Weight (shipment)": "weight",
  "Country (shipment)": "country",
  "State (shipment)": "state",
  "City (shipment)": "city",
  "Postal code (shipment)": "postalCode",
  "Units ordered (shipment)": "unitsOrdered",
  "Units shipped (shipment)": "unitsShipped",
  "SKU (product)": "sku",
  "Name (product)": "productName",
  "Bin type (bin storage)": "binType",
  "Days occupied (bin storage)": "daysOccupied",
  "Reason (return)": "returnReason",
  "Units received (return)": "unitsReceived",
  "Units restocked (return)": "unitsRestocked",
  "RMA carrier (return)": "rmaCarrier",
  "RMA method (return)": "rmaMethod",
  "RMA quoted cost (return)": "rmaQuotedCost",
  "Customer name (customer)": "customerName",
  "Customer ID (customer)": "customerId",
  "Bill # (bill)": "billNumber",
  "Period start (bill)": "periodStart",
  "Period end (bill)": "periodEnd",
  "Billed label cost (label reconciliation)": "billedLabelCost",
  "Reconciled label cost (label reconciliation)": "reconciledLabelCost",
  "ORDER NUMBER": "orderNumberUpper",
};

export interface ThreeplChargeRow {
  chargeDate: string | null;
  category: string | null;
  fee: string | null;
  type: string | null;
  label: string | null;
  description: string | null;
  unitRateCents: number | null;
  quantity: number | null;
  totalCents: number | null;

  /** Resolved from whichever order column actually carries `RH…`. */
  orderNumber: string | null;
  orderNumberSource: string | null;
  orderDate: string | null;
  trackingNumber: string | null;
  method: string | null;
  box: string | null;
  weight: number | null;
  country: string | null;
  state: string | null;
  city: string | null;
  postalCode: string | null;
  unitsOrdered: number | null;
  unitsShipped: number | null;

  sku: string | null;
  productName: string | null;
  binType: string | null;
  daysOccupied: number | null;

  returnReason: string | null;
  unitsReceived: number | null;
  unitsRestocked: number | null;
  rmaCarrier: string | null;
  rmaMethod: string | null;
  rmaQuotedCostCents: number | null;

  customerName: string | null;
  customerId: string | null;
  billNumber: string | null;
  periodStart: string | null;
  periodEnd: string | null;

  billedLabelCostCents: number | null;
  reconciledLabelCostCents: number | null;

  /** Every column not in KNOWN_COLUMNS, kept verbatim. */
  extra: Record<string, string>;
  /** The whole row, for audit. */
  raw: Record<string, string>;
}

export interface ParseResult {
  rows: ThreeplChargeRow[];
  /** Header columns not in KNOWN_COLUMNS. Reported, never silently ignored. */
  unknownColumns: string[];
  /** Which order column was used, and how well it matched. */
  orderColumn: OrderColumnChoice;
}

export interface OrderColumnChoice {
  chosen: string | null;
  /** Per candidate column: how many non-blank values look like an order name. */
  candidates: { column: string; present: number; matching: number }[];
  /** Rows carrying an order reference in the chosen column. */
  resolved: number;
  /** Rows where a shipment-shaped charge carried no usable reference. */
  unresolved: number;
}

function detectDelimiter(header: string): string {
  return header.includes("\t") ? "\t" : ",";
}

function splitLine(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t");
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
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

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.replace(/^"|"$/g, "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Money to cents.
 *
 * Returns null for a blank rather than 0: a charge line with no amount and a
 * charge line of zero dollars need opposite handling, and collapsing them is
 * how "no recorded cost" becomes indistinguishable from "free" (#91).
 * Parentheses are a credit, which the export uses for refunded charges.
 */
export function parseMoneyToCents(value: string | null): number | null {
  if (value === null) return null;
  const negative = /^\(.*\)$/.test(value);
  const cleaned = value.replace(/[()$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(Math.abs(n) * 100);
  return negative || n < 0 ? -cents : cents;
}

export function parseNumber(value: string | null): number | null {
  if (value === null) return null;
  const cleaned = value.replace(/[,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Picks the order column by evidence rather than by name.
 *
 * The export carries two candidates and which one holds the merchant reference
 * is not documented. Guessing wrong produces an import that succeeds with
 * every charge unattributed — a silent zero. So both are measured against the
 * order-name shape and the winner is reported with its rate.
 */
export function chooseOrderColumn(raws: Record<string, string>[]): OrderColumnChoice {
  const candidates = ORDER_COLUMNS.map((column) => {
    let present = 0;
    let matching = 0;
    for (const raw of raws) {
      const value = clean(raw[column]);
      if (value === null) continue;
      present++;
      if (ORDER_NUMBER_PATTERN.test(value)) matching++;
    }
    return { column: column as string, present, matching };
  });

  const best = candidates.reduce((a, b) => (b.matching > a.matching ? b : a));
  const chosen = best.matching > 0 ? best.column : null;

  let resolved = 0;
  let unresolved = 0;
  for (const raw of raws) {
    const value = chosen ? clean(raw[chosen]) : null;
    if (value !== null && ORDER_NUMBER_PATTERN.test(value)) resolved++;
    else if (clean(raw["Tracking # (shipment)"]) !== null) unresolved++;
  }

  return { chosen, candidates, resolved, unresolved };
}

export function parseThreeplChargeCsv(content: string): ParseResult {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) {
    throw new Error("3PL charge export is empty — nothing to import");
  }

  const delimiter = detectDelimiter(lines[0]);
  const header = splitLine(lines[0], delimiter).map((h) => h.replace(/^"|"$/g, "").trim());

  const required = ["Date (charge)", "Category (charge)", "Total (charge)"];
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `3PL charge export is missing required column(s): ${missing.join(", ")}. ` +
        `Found: ${header.slice(0, 8).join(", ")}…`,
    );
  }

  const raws: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const fields = splitLine(line, delimiter);
    const raw: Record<string, string> = {};
    header.forEach((col, i) => {
      raw[col] = fields[i] ?? "";
    });
    raws.push(raw);
  }

  const orderColumn = chooseOrderColumn(raws);
  const unknownColumns = header.filter((c) => !(c in KNOWN_COLUMNS));

  const rows = raws.map((raw) => {
    const g = (col: string) => clean(raw[col]);
    const orderValue = orderColumn.chosen ? g(orderColumn.chosen) : null;
    const orderNumber =
      orderValue !== null && ORDER_NUMBER_PATTERN.test(orderValue) ? orderValue.toUpperCase() : null;

    const extra: Record<string, string> = {};
    for (const col of unknownColumns) {
      const value = clean(raw[col]);
      if (value !== null) extra[col] = value;
    }

    return {
      chargeDate: g("Date (charge)"),
      category: g("Category (charge)"),
      fee: g("Fee (charge)"),
      type: g("Type (charge)"),
      label: g("Label (charge)"),
      description: g("Description (charge)"),
      unitRateCents: parseMoneyToCents(g("Unit rate (charge)")),
      quantity: parseNumber(g("Quantity (charge)")),
      totalCents: parseMoneyToCents(g("Total (charge)")),

      orderNumber,
      orderNumberSource: orderNumber === null ? null : orderColumn.chosen,
      orderDate: g("Order date (shipment)"),
      trackingNumber: g("Tracking # (shipment)"),
      method: g("Method (shipment)"),
      box: g("Box (shipment)"),
      weight: parseNumber(g("Weight (shipment)")),
      country: g("Country (shipment)"),
      state: g("State (shipment)"),
      city: g("City (shipment)"),
      postalCode: g("Postal code (shipment)"),
      unitsOrdered: parseNumber(g("Units ordered (shipment)")),
      unitsShipped: parseNumber(g("Units shipped (shipment)")),

      sku: g("SKU (product)"),
      productName: g("Name (product)"),
      binType: g("Bin type (bin storage)"),
      daysOccupied: parseNumber(g("Days occupied (bin storage)")),

      returnReason: g("Reason (return)"),
      unitsReceived: parseNumber(g("Units received (return)")),
      unitsRestocked: parseNumber(g("Units restocked (return)")),
      rmaCarrier: g("RMA carrier (return)"),
      rmaMethod: g("RMA method (return)"),
      rmaQuotedCostCents: parseMoneyToCents(g("RMA quoted cost (return)")),

      customerName: g("Customer name (customer)"),
      customerId: g("Customer ID (customer)"),
      billNumber: g("Bill # (bill)"),
      periodStart: g("Period start (bill)"),
      periodEnd: g("Period end (bill)"),

      billedLabelCostCents: parseMoneyToCents(g("Billed label cost (label reconciliation)")),
      reconciledLabelCostCents: parseMoneyToCents(g("Reconciled label cost (label reconciliation)")),

      extra,
      raw,
    };
  });

  return { rows, unknownColumns, orderColumn };
}

/**
 * The cost actually incurred for a shipping label.
 *
 * The export carries both what was billed and what reconciled after the
 * carrier weighed the parcel. Reconciled is the true figure where it exists,
 * but it is blank on rows that were never adjusted — so the fallback is normal
 * rather than degraded, and the caller is told which it got instead of the
 * two being blended into one untraceable number.
 */
export function labelCost(row: ThreeplChargeRow): { cents: number | null; basis: "reconciled" | "billed" | "none" } {
  if (row.reconciledLabelCostCents !== null) {
    return { cents: row.reconciledLabelCostCents, basis: "reconciled" };
  }
  if (row.billedLabelCostCents !== null) {
    return { cents: row.billedLabelCostCents, basis: "billed" };
  }
  return { cents: null, basis: "none" };
}
