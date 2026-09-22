/**
 * Imports the 3PL shipment export into `threepl_shipments` (#34).
 *
 * Upsert by label id rather than replace-by-period, because this export is
 * pulled by date range rather than issued per bill: two pulls will overlap,
 * and re-importing an overlapping range must converge rather than duplicate.
 *
 * As with the charge import, every decision is a pure function over the parse
 * result and the set of order numbers known to exist. The IO wrapper does two
 * queries and no thinking.
 */

import { inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { threeplShipments, shopifyOrders } from "@/db/schema";
import type { NewThreeplShipmentRow } from "@/db/schema";
import {
  parseShipmentsCsv,
  postageCoverage,
  type ShipmentParseResult,
  type PostageCoverage,
} from "./parse-shipments-csv";

export interface ShipmentImportResult {
  shipments: number;
  dateRange: { from: string | null; to: string | null };
  coverage: PostageCoverage;
  orders: {
    referenced: number;
    matched: number;
    unmatchedExamples: string[];
  };
  /** Methods seen at 0.00 that are not known to be billed elsewhere. */
  unexpectedZeroMethods: string[];
  unknownColumns: string[];
  warnings: string[];
}

export interface ShipmentImportPlan {
  values: NewThreeplShipmentRow[];
  result: ShipmentImportResult;
}

export class ShipmentImportError extends Error {}

export function planShipmentImport(args: {
  parsed: ShipmentParseResult;
  knownOrderNumbers: string[];
  sourceFile?: string;
}): { ok: true; plan: ShipmentImportPlan } | { ok: false; error: string } {
  const { rows, unexpectedZeroMethods, unknownColumns } = args.parsed;

  if (rows.length === 0) {
    return { ok: false, error: "The shipment export parsed to zero rows — nothing to import." };
  }

  const missingId = rows.filter((r) => r.labelId === null).length;
  if (missingId > 0) {
    return {
      ok: false,
      error:
        `${missingId} shipment(s) have no label id. It is the key an overlapping re-import ` +
        `converges on, and without it the same shipment would be stored twice.`,
    };
  }

  const referenced = [...new Set(rows.map((r) => r.orderNumber).filter((o): o is string => o !== null))];
  const known = new Set(args.knownOrderNumbers);
  const unmatched = referenced.filter((o) => !known.has(o));

  if (referenced.length > 0 && known.size === 0) {
    return {
      ok: false,
      error:
        `None of the ${referenced.length} order references in this export exist in ` +
        `shopify_orders (e.g. ${unmatched.slice(0, 3).join(", ")}). Importing would leave every ` +
        `shipment attributed to no order, and postage would vanish from cost of delivery.`,
    };
  }

  const coverage = postageCoverage(rows);
  const warnings: string[] = [];

  // The headline number looks the same at 31% coverage as at 100%.
  if (coverage.unbilled > 0) {
    warnings.push(
      `${coverage.unbilled} of ${coverage.shipments} shipments have postage billed to an account ` +
        `this export cannot see, so only ${(coverage.coverage * 100).toFixed(1)}% of postage is known. ` +
        `Any cost of delivery derived from this is a floor.`,
    );
  }
  if (unexpectedZeroMethods.length > 0) {
    warnings.push(
      `Method(s) seen at $0.00 that are not known to be billed elsewhere: ` +
        `${unexpectedZeroMethods.join(", ")}. They are counted as genuinely free until classified.`,
    );
  }
  if (unmatched.length > 0) {
    warnings.push(
      `${unmatched.length} order reference(s) are not in shopify_orders: ` +
        `${unmatched.slice(0, 5).join(", ")}. Their postage attributes to no order.`,
    );
  }
  if (unknownColumns.length > 0) {
    warnings.push(`${unknownColumns.length} column(s) are not mapped.`);
  }

  const dates = rows.map((r) => r.createdAt).filter((d): d is string => d !== null).sort();

  const values: NewThreeplShipmentRow[] = rows.map((r) => ({
    id: r.labelId as string,
    orderNumber: r.orderNumber,
    orderDate: r.orderDate,
    createdAt: r.createdAt,
    carrier: r.carrier,
    shippingMethod: r.shippingMethod,
    trackingNumber: r.trackingNumber,
    weightLb: r.weightLb,
    shippingChargedCents: r.shippingChargedCents,
    labelCostCents: r.labelCostCents,
    postageBasis: r.postageBasis,
    state: r.state,
    postalCode: r.postalCode,
    country: r.country,
    raw: r.raw,
    sourceFile: args.sourceFile ?? null,
  }));

  return {
    ok: true,
    plan: {
      values,
      result: {
        shipments: rows.length,
        dateRange: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null },
        coverage,
        orders: {
          referenced: referenced.length,
          matched: referenced.length - unmatched.length,
          unmatchedExamples: unmatched.slice(0, 10),
        },
        unexpectedZeroMethods,
        unknownColumns,
        warnings,
      },
    },
  };
}

export async function importShipments(
  db: Db,
  csvContent: string,
  options: { sourceFile?: string } = {},
): Promise<ShipmentImportResult> {
  const parsed = parseShipmentsCsv(csvContent);

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

  const planned = planShipmentImport({ parsed, knownOrderNumbers: known, sourceFile: options.sourceFile });
  if (!planned.ok) throw new ShipmentImportError(planned.error);

  // Upsert: pulls by date range overlap, so the same label arrives twice.
  const CHUNK = 500;
  for (let i = 0; i < planned.plan.values.length; i += CHUNK) {
    await db
      .insert(threeplShipments)
      .values(planned.plan.values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: threeplShipments.id,
        set: {
          orderNumber: sql`excluded.order_number`,
          orderDate: sql`excluded.order_date`,
          createdAt: sql`excluded.created_at_date`,
          carrier: sql`excluded.carrier`,
          shippingMethod: sql`excluded.shipping_method`,
          trackingNumber: sql`excluded.tracking_number`,
          weightLb: sql`excluded.weight_lb`,
          shippingChargedCents: sql`excluded.shipping_charged_cents`,
          labelCostCents: sql`excluded.label_cost_cents`,
          postageBasis: sql`excluded.postage_basis`,
          state: sql`excluded.state`,
          postalCode: sql`excluded.postal_code`,
          country: sql`excluded.country`,
          raw: sql`excluded.raw`,
          sourceFile: sql`excluded.source_file`,
          importedAt: sql`now()`,
        },
      });
  }

  return planned.plan.result;
}
