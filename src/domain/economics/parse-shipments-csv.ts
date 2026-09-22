/**
 * Parses the 3PL shipment export — one row per shipping label (#34).
 *
 * This is the file that made postage attributable. Its `Label Cost` column
 * reconciled to the cent against the gap between invoice 720698 and the charge
 * ledger ($129.74 over 57 shipments), which is how we know the gap was postage
 * and not something else.
 *
 * ## The zero that is not a zero
 *
 * 1,726 of 2,508 shipments — every DHL BPM Ground label, in all thirteen
 * months — carry `Label Cost = 0.00`. BPM is not free. Those labels bill to a
 * separate DHL eCommerce account and their cost appears in neither the ledger
 * nor the Evobox invoice.
 *
 * So a zero here is read as UNKNOWN, not as free, and `postageBasis` records
 * which it is. Importing $0.00 at face value would understate physical cost of
 * delivery by every BPM shipment while looking complete — the #91 failure, at
 * 69% of the shipment base.
 *
 * A genuine zero is still representable: it needs a carrier that does not bill
 * to the outside account, which is what `CARRIERS_BILLED_ELSEWHERE` names.
 */

export interface ShipmentRow {
  labelId: string | null;
  orderNumber: string | null;
  orderDate: string | null;
  createdAt: string | null;
  carrier: string | null;
  shippingMethod: string | null;
  trackingNumber: string | null;
  weightLb: number | null;
  /** What the customer paid for shipping on this order. */
  shippingChargedCents: number | null;
  /**
   * What the label cost, when the 3PL billed it. Null where the export said
   * 0.00 for a carrier billed elsewhere — absent, not free.
   */
  labelCostCents: number | null;
  /**
   * billed      — the 3PL charged it and the amount is theirs
   * unbilled    — billed to a separate carrier account; cost unknown here
   * zero        — genuinely no cost, from a carrier that does bill through
   */
  postageBasis: "billed" | "unbilled" | "zero";
  state: string | null;
  /**
   * Destination postcode. Carried because carrier rates are priced by zone,
   * and a zone is derived from the origin/destination zip prefix — not from
   * the state, which can span two zones and would mis-rate silently.
   */
  postalCode: string | null;
  country: string | null;
  raw: Record<string, string>;
}

/**
 * Shipping methods whose postage is billed to an account the 3PL does not
 * invoice, so a 0.00 in this export means "not recorded here".
 *
 * Deliberately a list of specific methods rather than a rule like "any zero is
 * unknown". A carrier that genuinely bills through and legitimately costs
 * nothing must stay distinguishable, and a new method appearing at 0.00 should
 * be noticed rather than silently absorbed into the unknown pile.
 */
export const CARRIERS_BILLED_ELSEWHERE = new Set(["DHL BPM Ground"]);

export interface ShipmentParseResult {
  rows: ShipmentRow[];
  /** Shipments whose postage is not in this file. */
  unbilled: number;
  /** Shipments carrying a real cost. */
  billed: number;
  /** Total of the costs that are known, in cents. */
  billedCents: number;
  /**
   * Methods seen at 0.00 that are NOT in CARRIERS_BILLED_ELSEWHERE. A new one
   * appearing here means the list needs updating, and until it is, those rows
   * are counted as a genuine zero — which is the wrong direction to be wrong
   * in silently.
   */
  unexpectedZeroMethods: string[];
  unknownColumns: string[];
}

const KNOWN_COLUMNS = new Set([
  "Shipping Label ID", "Order Number", "Order date", "Created at", "Carrier",
  "Shipping Method", "Tracking Number", "Weight (lb)", "Total Shipping Charged",
  "Label Cost", "State", "Country", "Zip",
]);

function splitRecords(content: string): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let sawAny = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') {
        current += '"';
        i++;
      } else inQuotes = !inQuotes;
      sawAny = true;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
      sawAny = true;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      fields.push(current);
      if (sawAny) records.push(fields);
      fields = [];
      current = "";
      sawAny = false;
    } else {
      current += ch;
      if (ch.trim() !== "") sawAny = true;
    }
  }
  fields.push(current);
  if (sawAny) records.push(fields);
  return records;
}

function clean(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function toCents(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function toNumber(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.replace(/[,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** `2026-09-04 11:09:07` → `2026-09-04`. */
export function toDate(v: string | null): string | null {
  if (v === null) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function parseShipmentsCsv(content: string): ShipmentParseResult {
  if (content.trim() === "") {
    throw new Error("Shipment export is empty — nothing to import.");
  }

  const records = splitRecords(content);
  const header = records[0].map((h) => h.trim());
  for (const required of ["Order Number", "Label Cost", "Shipping Method"]) {
    if (!header.includes(required)) {
      throw new Error(
        `Shipment export is missing the '${required}' column. Found: ${header.slice(0, 6).join(", ")}…`,
      );
    }
  }

  const unexpectedZero = new Set<string>();
  const rows: ShipmentRow[] = [];

  for (const fields of records.slice(1)) {
    const raw: Record<string, string> = {};
    header.forEach((col, i) => {
      raw[col] = fields[i] ?? "";
    });
    const g = (col: string) => clean(raw[col]);

    const method = g("Shipping Method");
    const rawCost = toCents(g("Label Cost"));
    const billedElsewhere = method !== null && CARRIERS_BILLED_ELSEWHERE.has(method);

    let postageBasis: ShipmentRow["postageBasis"];
    let labelCostCents: number | null;
    if (rawCost !== null && rawCost > 0) {
      postageBasis = "billed";
      labelCostCents = rawCost;
    } else if (billedElsewhere) {
      postageBasis = "unbilled";
      labelCostCents = null;
    } else {
      postageBasis = "zero";
      labelCostCents = rawCost;
      if (method !== null) unexpectedZero.add(method);
    }

    rows.push({
      labelId: g("Shipping Label ID"),
      orderNumber: g("Order Number")?.toUpperCase() ?? null,
      orderDate: toDate(g("Order date")),
      createdAt: toDate(g("Created at")),
      carrier: g("Carrier"),
      shippingMethod: method,
      trackingNumber: g("Tracking Number"),
      weightLb: toNumber(g("Weight (lb)")),
      shippingChargedCents: toCents(g("Total Shipping Charged")),
      labelCostCents,
      postageBasis,
      state: g("State"),
      postalCode: g("Zip"),
      country: g("Country"),
      raw,
    });
  }

  const billed = rows.filter((r) => r.postageBasis === "billed");
  return {
    rows,
    billed: billed.length,
    unbilled: rows.filter((r) => r.postageBasis === "unbilled").length,
    billedCents: billed.reduce((s, r) => s + (r.labelCostCents ?? 0), 0),
    unexpectedZeroMethods: [...unexpectedZero],
    unknownColumns: header.filter((h) => !KNOWN_COLUMNS.has(h)),
  };
}

export interface PostageCoverage {
  shipments: number;
  billed: number;
  unbilled: number;
  /** Share of shipments whose postage is actually known, 0–1. */
  coverage: number;
  knownCents: number;
}

/**
 * How much of the postage is real.
 *
 * Every figure derived from these rows has to carry this, because the headline
 * number looks the same whether postage is 100% measured or 31% measured and
 * 69% missing. Returned as a value rather than logged, so the caller cannot
 * quote the cost without the coverage.
 */
export function postageCoverage(rows: ShipmentRow[]): PostageCoverage {
  const billed = rows.filter((r) => r.postageBasis === "billed");
  const unbilled = rows.filter((r) => r.postageBasis === "unbilled");
  return {
    shipments: rows.length,
    billed: billed.length,
    unbilled: unbilled.length,
    coverage: rows.length === 0 ? 0 : billed.length / rows.length,
    knownCents: billed.reduce((s, r) => s + (r.labelCostCents ?? 0), 0),
  };
}
