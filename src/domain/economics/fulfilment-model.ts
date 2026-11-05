/**
 * Fulfilment cost per order, from what the 3PL and its carriers billed.
 *
 * Neither invoice names an order, so a per-order cost is an average: the
 * handling billed over a set of days divided by the orders shipped on those
 * days, and the postage billed divided by the shipments the carrier invoice
 * itself counts. Over a window inside the invoiced days that average is
 * measured; applied to days no invoice covers it is an estimate, and is
 * labelled so rather than passed off as the other.
 *
 * What scales with orders goes into cost of delivery: pick/pack ("order"),
 * ad hoc, returns, postage. What does not — storage, the API fee, the
 * monthly-minimum top-up — is overhead, reported per month and kept out of
 * COD, because a fixed fee folded into a per-order cost makes COD% move with
 * volume (CLAUDE.md, 3PL cost data).
 */

import type { FulfilmentRates } from "./unit-economics";

export interface InvoiceLineInput {
  source: string;
  category: string;
  amountCents: number;
  /** ISO dates, inclusive. */
  periodStart: string;
  periodEnd: string;
  shipments: number | null;
}

const HANDLING = new Set(["order", "ad_hoc", "returns"]);
const OVERHEAD = new Set(["storage", "recurring", "minimum"]);

const DAY = 86_400_000;
function days(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

interface Coverage {
  from: string;
  to: string;
  /** Distinct days some invoice covers — gaps between invoices are not counted. */
  daysInvoiced: number;
  amountCents: number;
}

export interface FulfilmentModel {
  rates: FulfilmentRates;
  coverage: {
    handling: (Coverage & { shippedOrders: number }) | null;
    postage: (Coverage & { shipments: number }) | null;
  };
  /** Storage, recurring and minimum top-ups as a monthly figure. Overhead, not COD. */
  fixedOverheadMonthlyCents: number | null;
  notes: string[];
}

function cover(lines: InvoiceLineInput[]): { days: Set<string>; coverage: Coverage } | null {
  if (lines.length === 0) return null;
  const set = new Set(lines.flatMap((l) => days(l.periodStart, l.periodEnd)));
  const sorted = [...set].sort();
  return {
    days: set,
    coverage: { from: sorted[0], to: sorted.at(-1)!, daysInvoiced: set.size, amountCents: lines.reduce((s, l) => s + l.amountCents, 0) },
  };
}

export function computeFulfilmentRates(
  invoices: InvoiceLineInput[],
  shippedByDay: Map<string, number>,
  window: { start: string; end: string },
): FulfilmentModel {
  const notes: string[] = [];
  const windowDays = days(window.start, window.end);
  const basisFor = (covered: Set<string>, what: string): "measured" | "estimated" => {
    const outside = windowDays.filter((d) => !covered.has(d)).length;
    if (outside === 0) return "measured";
    notes.push(`${what} is an average from invoiced days applied beyond them: ${outside} of the window's ${windowDays.length} days have no invoice.`);
    return "estimated";
  };

  const evobox = invoices.filter((l) => l.source === "evobox");
  const handlingLines = cover(evobox.filter((l) => HANDLING.has(l.category)));
  let handling: FulfilmentModel["coverage"]["handling"] = null;
  let handlingRate: FulfilmentRates["handling"] = null;
  if (handlingLines) {
    const shippedOrders = [...handlingLines.days].reduce((s, d) => s + (shippedByDay.get(d) ?? 0), 0);
    handling = { ...handlingLines.coverage, shippedOrders };
    if (shippedOrders === 0) {
      notes.push("The 3PL billed handling over days with no shipped orders on record, so no per-order rate can be formed.");
    } else {
      handlingRate = { perShippedOrderCents: Math.round(handlingLines.coverage.amountCents / shippedOrders), basis: basisFor(handlingLines.days, "Handling") };
    }
  }

  const postageLines = cover(invoices.filter((l) => l.source === "carrier"));
  let postage: FulfilmentModel["coverage"]["postage"] = null;
  let postageRate: FulfilmentRates["postage"] = null;
  if (postageLines) {
    const shipments = invoices.filter((l) => l.source === "carrier").reduce((s, l) => s + (l.shipments ?? 0), 0);
    postage = { ...postageLines.coverage, shipments };
    if (shipments > 0) {
      postageRate = { perShipmentCents: Math.round(postageLines.coverage.amountCents / shipments), basis: basisFor(postageLines.days, "Postage") };
    }
  }

  const evoboxDays = cover(evobox);
  const overheadCents = evobox.filter((l) => OVERHEAD.has(l.category)).reduce((s, l) => s + l.amountCents, 0);
  const fixedOverheadMonthlyCents = evoboxDays ? Math.round((overheadCents / evoboxDays.days.size) * (365 / 12)) : null;

  return { rates: { handling: handlingRate, postage: postageRate }, coverage: { handling, postage }, fixedOverheadMonthlyCents, notes };
}
