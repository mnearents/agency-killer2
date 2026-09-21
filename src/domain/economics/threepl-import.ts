/**
 * Imports a 3PL charge export into `threepl_charges` (#34).
 *
 * Two things this does beyond inserting rows, both because the failures they
 * catch are otherwise invisible:
 *
 * 1. **It verifies the orders exist.** A bill whose order references match
 *    nothing still imports cleanly and leaves every charge attributed to no
 *    order — which reads downstream as a line that cost nothing to fulfil,
 *    not as a broken import. The match rate is measured against
 *    `shopify_orders` and returned, and a bill that resolves no orders at all
 *    is refused rather than stored.
 *
 * 2. **It replaces by bill number.** A re-issued bill must not double-count,
 *    and an importer that appends would leave two versions summing to twice
 *    the real cost. A bill with no number is refused, because the weaker
 *    fallback (dedupe by row content) cannot tell a correction from a
 *    duplicate.
 */

import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { threeplCharges, shopifyOrders, recurringCosts } from "@/db/schema";
import type { NewThreeplChargeDbRow, NewRecurringCostRow } from "@/db/schema";
import {
  parseThreeplChargeCsv,
  type ThreeplChargeRow,
  type OrderColumnChoice,
  type ParseResult,
} from "./parse-threepl-csv";

export interface ThreeplImportResult {
  billNumber: string;
  periodStart: string | null;
  periodEnd: string | null;
  rowsParsed: number;
  inserted: number;
  /** Rows removed because this bill had been imported before. */
  replaced: number;
  totalCents: number;
  /** Per category: how many rows and how much. */
  byCategory: { category: string; rows: number; cents: number }[];
  orderColumn: OrderColumnChoice;
  orders: OrderMatch;
  unknownColumns: string[];
  /** Recurring charges found in the bill — candidates for `recurring_costs`. */
  recurringFound: { fee: string; cents: number }[];
  /** Non-fatal observations worth surfacing to whoever ran the import. */
  warnings: string[];
}

export interface OrderMatch {
  /** Distinct order references in the bill. */
  referenced: number;
  /** How many of those exist in `shopify_orders`. */
  matched: number;
  /** Up to 10 examples, so a systematic mismatch is diagnosable. */
  unmatchedExamples: string[];
}

export class ThreeplImportError extends Error {}

function rowId(billNumber: string, row: ThreeplChargeRow, index: number): string {
  // Index is included because a bill legitimately repeats identical charge
  // lines — two pick fees on the same order at the same rate are two charges,
  // not a duplicate. Hashing content alone would collapse them.
  const hash = createHash("sha256")
    .update(JSON.stringify([billNumber, index, row.raw]))
    .digest("hex")
    .slice(0, 32);
  return `${billNumber}:${hash}`;
}

function summarise(rows: ThreeplChargeRow[]): { category: string; rows: number; cents: number }[] {
  const map = new Map<string, { rows: number; cents: number }>();
  for (const row of rows) {
    const key = row.category ?? "(none)";
    const entry = map.get(key) ?? { rows: 0, cents: 0 };
    entry.rows++;
    entry.cents += row.totalCents ?? 0;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.cents - a.cents);
}

/**
 * The whole decision, as a pure function.
 *
 * Every refusal and every warning below is a judgement about data, not about
 * the database, so none of it needs one. The IO wrapper underneath does three
 * queries and no thinking, which is what keeps this testable without a fake
 * Drizzle.
 */
export function planThreeplImport(args: {
  parsed: ParseResult;
  /** Order numbers confirmed to exist in `shopify_orders`. */
  knownOrderNumbers: string[];
  /** Rows already stored for this bill, which an import replaces. */
  existingRowCount: number;
  sourceFile?: string;
}): { ok: true; plan: ImportPlan } | { ok: false; error: string } {
  const { rows, unknownColumns, orderColumn } = args.parsed;

  if (rows.length === 0) {
    return { ok: false, error: "The export parsed to zero charge rows — nothing to import." };
  }

  const billNumbers = [...new Set(rows.map((r) => r.billNumber).filter((b): b is string => b !== null))];
  if (billNumbers.length === 0) {
    return {
      ok: false,
      error:
        "No bill number on any row. The import replaces a bill by its number, and without one a " +
        "re-issued bill cannot be told from a duplicate.",
    };
  }
  if (billNumbers.length > 1) {
    return {
      ok: false,
      error:
        `The export covers ${billNumbers.length} bills (${billNumbers.join(", ")}). ` +
        `Import one bill at a time so each can be replaced independently.`,
    };
  }
  const billNumber = billNumbers[0];

  const referenced = [...new Set(rows.map((r) => r.orderNumber).filter((o): o is string => o !== null))];
  const matchedSet = new Set(args.knownOrderNumbers);
  const orders: OrderMatch = {
    referenced: referenced.length,
    matched: referenced.filter((o) => matchedSet.has(o)).length,
    unmatchedExamples: referenced.filter((o) => !matchedSet.has(o)).slice(0, 10),
  };

  // A bill that resolves no orders is a broken join, not a quiet month.
  if (referenced.length > 0 && orders.matched === 0) {
    return {
      ok: false,
      error:
        `None of the ${referenced.length} order references in bill ${billNumber} exist in ` +
        `shopify_orders (e.g. ${orders.unmatchedExamples.slice(0, 3).join(", ")}). ` +
        `Importing would attribute every charge to no order, which reads downstream as a ` +
        `line that cost nothing to fulfil.`,
    };
  }

  const warnings: string[] = [];
  if (orderColumn.chosen === null && rows.some((r) => r.trackingNumber !== null)) {
    warnings.push(
      "The bill has shipment charges but neither order column carried a usable reference, " +
        "so those charges are attributed to no order.",
    );
  }
  if (orderColumn.unresolved > 0) {
    warnings.push(
      `${orderColumn.unresolved} shipment charge(s) carried no order reference and are unattributed.`,
    );
  }
  if (orders.unmatchedExamples.length > 0) {
    warnings.push(
      `${orders.referenced - orders.matched} order reference(s) are not in shopify_orders, ` +
        `e.g. ${orders.unmatchedExamples.slice(0, 3).join(", ")}.`,
    );
  }
  // Postage is the largest component of physical COD. Its absence has to be
  // stated, because a bill without it looks complete.
  if (!rows.some((r) => r.billedLabelCostCents !== null || r.reconciledLabelCostCents !== null)) {
    warnings.push(
      "No carrier label cost on any row: this bill covers handling only, so physical cost of " +
        "delivery is not complete from it alone.",
    );
  }
  if (unknownColumns.length > 0) {
    warnings.push(`${unknownColumns.length} column(s) are not mapped and were kept in extra.`);
  }

  const values = rows.map((row, index) => ({
    id: rowId(billNumber, row, index),
    billNumber,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    chargeDate: row.chargeDate,
    category: row.category,
    fee: row.fee,
    type: row.type,
    label: row.label,
    description: row.description,
    unitRateCents: row.unitRateCents,
    quantity: row.quantity,
    totalCents: row.totalCents,
    orderNumber: row.orderNumber,
    orderNumberSource: row.orderNumberSource,
    orderDate: row.orderDate,
    trackingNumber: row.trackingNumber,
    method: row.method,
    box: row.box,
    weight: row.weight,
    country: row.country,
    state: row.state,
    city: row.city,
    postalCode: row.postalCode,
    unitsOrdered: row.unitsOrdered,
    unitsShipped: row.unitsShipped,
    sku: row.sku,
    productName: row.productName,
    binType: row.binType,
    daysOccupied: row.daysOccupied,
    returnReason: row.returnReason,
    unitsReceived: row.unitsReceived,
    unitsRestocked: row.unitsRestocked,
    rmaCarrier: row.rmaCarrier,
    rmaMethod: row.rmaMethod,
    rmaQuotedCostCents: row.rmaQuotedCostCents,
    customerName: row.customerName,
    customerId: row.customerId,
    billedLabelCostCents: row.billedLabelCostCents,
    reconciledLabelCostCents: row.reconciledLabelCostCents,
    extra: row.extra,
    raw: row.raw,
    sourceFile: args.sourceFile ?? null,
  }));

  return {
    ok: true,
    plan: {
      billNumber,
      values,
      result: {
        billNumber,
        periodStart: rows.find((r) => r.periodStart !== null)?.periodStart ?? null,
        periodEnd: rows.find((r) => r.periodEnd !== null)?.periodEnd ?? null,
        rowsParsed: rows.length,
        inserted: values.length,
        replaced: args.existingRowCount,
        totalCents: rows.reduce((sum, r) => sum + (r.totalCents ?? 0), 0),
        byCategory: summarise(rows),
        orderColumn,
        orders,
        unknownColumns,
        recurringFound: rows
          .filter((r) => r.category === "recurring")
          .map((r) => ({ fee: r.fee ?? "(unnamed)", cents: r.totalCents ?? 0 })),
        warnings,
      },
    },
  };
}

export interface ImportPlan {
  billNumber: string;
  values: NewThreeplChargeDbRow[];
  result: ThreeplImportResult;
}

/** The IO half: three queries, no judgement. */
export async function importThreeplCharges(
  db: Db,
  csvContent: string,
  options: { sourceFile?: string } = {},
): Promise<ThreeplImportResult> {
  const parsed = parseThreeplChargeCsv(csvContent);

  const referenced = [
    ...new Set(parsed.rows.map((r) => r.orderNumber).filter((o): o is string => o !== null)),
  ];
  const known =
    referenced.length === 0
      ? []
      : (
          await db
            .select({ orderNumber: shopifyOrders.orderNumber })
            .from(shopifyOrders)
            .where(inArray(shopifyOrders.orderNumber, referenced))
        )
          .map((f) => f.orderNumber)
          .filter((o): o is string => o !== null);

  const billNumbers = [
    ...new Set(parsed.rows.map((r) => r.billNumber).filter((b): b is string => b !== null)),
  ];
  const existing =
    billNumbers.length === 1
      ? await db
          .select({ id: threeplCharges.id })
          .from(threeplCharges)
          .where(eq(threeplCharges.billNumber, billNumbers[0]))
      : [];

  const planned = planThreeplImport({
    parsed,
    knownOrderNumbers: known,
    existingRowCount: existing.length,
    sourceFile: options.sourceFile,
  });
  if (!planned.ok) throw new ThreeplImportError(planned.error);

  if (existing.length > 0) {
    await db.delete(threeplCharges).where(eq(threeplCharges.billNumber, planned.plan.billNumber));
  }
  await db.insert(threeplCharges).values(planned.plan.values);

  return planned.plan.result;
}

/**
 * Opens a `recurring_costs` row for a recurring charge the bill disclosed.
 *
 * Returns what it did rather than doing it silently: an unchanged cost, a
 * changed one that closed the previous row, and a first sighting need
 * different responses from whoever ran the import.
 */
export interface RecurringCostInput {
  name: string;
  amountCents: number;
  effectiveFrom: string;
  cadence: string;
  vendor?: string;
}

export interface RecurringCostPlan {
  action: "unchanged" | "opened" | "changed";
  previousCents: number | null;
  /** The open row to close, if the amount moved. */
  closeId: string | null;
  insert: NewRecurringCostRow | null;
}

export function planRecurringCost(
  openRow: { id: string; amountCents: number } | undefined,
  input: RecurringCostInput,
): RecurringCostPlan {
  if (openRow && openRow.amountCents === input.amountCents) {
    return { action: "unchanged", previousCents: openRow.amountCents, closeId: null, insert: null };
  }
  return {
    action: openRow ? "changed" : "opened",
    previousCents: openRow ? openRow.amountCents : null,
    closeId: openRow ? openRow.id : null,
    insert: {
      id: `${input.name}:${input.effectiveFrom}`.toLowerCase().replace(/\s+/g, "-"),
      name: input.name,
      vendor: input.vendor ?? null,
      amountCents: input.amountCents,
      cadence: input.cadence,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      source: "threepl",
      notes: null,
    },
  };
}

export async function reconcileRecurringCost(
  db: Db,
  input: RecurringCostInput,
): Promise<RecurringCostPlan> {
  const rows = await db.select().from(recurringCosts).where(eq(recurringCosts.name, input.name));
  const plan = planRecurringCost(
    rows.find((r) => r.effectiveTo === null),
    input,
  );

  if (plan.closeId !== null) {
    await db
      .update(recurringCosts)
      .set({ effectiveTo: input.effectiveFrom })
      .where(eq(recurringCosts.id, plan.closeId));
  }
  if (plan.insert !== null) {
    await db.insert(recurringCosts).values(plan.insert);
  }
  return plan;
}
