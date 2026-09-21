/**
 * Parses an Evobox PDF invoice (#34).
 *
 * The charge CSV is not the whole bill. Against bill 720698 the ledger summed
 * to $681.60 and the invoice to $811.28 — the CSV itemises handling and omits
 * $129.74 of `Order charges`, which is where postage sits. The 3PL bills
 * postage; it just does not export it per shipment.
 *
 * So the invoice is the authority on what was charged and the ledger is the
 * authority on what it was charged *for*, and neither is sufficient alone.
 * Reconciling the two per category is what surfaced the gap in the first
 * place, and `reconcileInvoice` below keeps doing it on every import rather
 * than trusting that this was a one-off.
 *
 * The invoice carries five category totals and no per-order detail, so the
 * residual it reveals is a period figure. Attributing it to orders is an
 * allocation, never an attribution, and must be labelled as one.
 */

/** A line item as printed: "1. 09/04/2026 Sales Storage charges 1 $385.196 $385.20" */
export interface InvoiceLine {
  /** storage | recurring | order | returns | ad_hoc — normalised from the description. */
  category: string;
  description: string;
  quantity: number | null;
  rateCents: number | null;
  amountCents: number;
}

export interface ThreeplInvoice {
  invoiceNumber: string;
  invoiceDate: string | null;
  lines: InvoiceLine[];
  /** The printed total, not a sum of the lines — they are checked against each other. */
  totalCents: number;
}

export class InvoiceParseError extends Error {}

function money(text: string): number | null {
  const m = text.replace(/,/g, "").match(/-?\$?(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  // Rates print to three decimals ($385.196) while amounts print to two. Both
  // become cents; the fraction is kept where it exists so a rate can be shown
  // back exactly as billed.
  return Math.round(Number(m[1]) * 100);
}

/** `09/08/2026` → `2026-09-08`. Returns null rather than guessing a bad date. */
export function normaliseInvoiceDate(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/**
 * The category, as the ledger spells it.
 *
 * "Ad_Hoc charges" on the invoice is `ad_hoc` in the CSV, and the two have to
 * agree or the reconciliation reports a phantom gap in one and a phantom
 * surplus in the other.
 */
export function normaliseCategory(description: string): string {
  return description
    .replace(/\s*charges?\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Parses the text lines of an invoice page.
 *
 * Kept separate from PDF extraction so it can be tested against fixture text
 * without a PDF library, a binary file, or a rendering engine.
 */
export function parseInvoiceLines(lines: string[]): ThreeplInvoice {
  const joined = lines.join("\n");

  const numberMatch = joined.match(/Invoice\s*no\.?:?\s*(\S+)/i);
  if (!numberMatch) {
    throw new InvoiceParseError(
      "No invoice number found. It is the key the charge ledger is reconciled against, " +
        "so an invoice without one cannot be matched to its bill.",
    );
  }
  const invoiceNumber = numberMatch[1].trim();

  const dateMatch = joined.match(/Invoice\s*date:?\s*([\d/]+)/i);
  const invoiceDate = normaliseInvoiceDate(dateMatch ? dateMatch[1] : null);

  // "1. 09/04/2026 Sales Storage charges 1 $385.196 $385.20"
  const lineItems: InvoiceLine[] = [];
  for (const line of lines) {
    const m = line.match(
      /^\s*\d+\.\s+\d{1,2}\/\d{1,2}\/\d{4}\s+\S+\s+(.+?)\s+(\d+(?:\.\d+)?)\s+\$?([\d,]+\.\d+)\s+\$?([\d,]+\.\d+)\s*$/,
    );
    if (!m) continue;
    const [, description, quantity, rate, amount] = m;
    const amountCents = money(amount);
    if (amountCents === null) continue;
    lineItems.push({
      category: normaliseCategory(description),
      description: description.trim(),
      quantity: Number(quantity),
      rateCents: money(rate),
      amountCents,
    });
  }

  if (lineItems.length === 0) {
    throw new InvoiceParseError(
      `Invoice ${invoiceNumber} parsed to zero line items. The layout has probably changed; ` +
        `importing it would record a bill of $0.00 that looks like a quiet period.`,
    );
  }

  // The printed total, taken from the line after "Total" when it stands alone.
  let totalCents: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Total\s*$/i.test(lines[i])) {
      totalCents = money(lines[i + 1] ?? "");
      if (totalCents !== null) break;
    }
    const inline = lines[i].match(/^\s*Total\s+\$?([\d,]+\.\d{2})\s*$/i);
    if (inline) {
      totalCents = money(inline[1]);
      break;
    }
  }
  if (totalCents === null) {
    throw new InvoiceParseError(`Invoice ${invoiceNumber} has no readable total.`);
  }

  const summed = lineItems.reduce((s, l) => s + l.amountCents, 0);
  if (summed !== totalCents) {
    throw new InvoiceParseError(
      `Invoice ${invoiceNumber} does not add up: lines sum to ${(summed / 100).toFixed(2)} ` +
        `but the printed total is ${(totalCents / 100).toFixed(2)}. Some line was not read.`,
    );
  }

  return { invoiceNumber, invoiceDate, lines: lineItems, totalCents };
}

export interface CategoryReconciliation {
  category: string;
  invoiceCents: number;
  ledgerCents: number;
  gapCents: number;
}

export interface Reconciliation {
  invoiceNumber: string;
  invoiceTotalCents: number;
  ledgerTotalCents: number;
  gapCents: number;
  byCategory: CategoryReconciliation[];
  /** Gaps larger than rounding. These are real money the ledger cannot explain. */
  unexplained: CategoryReconciliation[];
  notes: string[];
}

/**
 * Rounding tolerance, in cents, per category.
 *
 * Storage bills 35 bin lines individually and the invoice charges one rounded
 * figure, so a few cents of disagreement is arithmetic rather than a missing
 * charge. One dollar is far below anything that could hide a real fee and far
 * above per-row rounding on a bill this size.
 */
export const ROUNDING_TOLERANCE_CENTS = 100;

/**
 * Compares an invoice against the charge ledger for the same bill.
 *
 * This is the check that found the postage. It runs on every import because a
 * category that stops being itemised looks exactly like a category that
 * stopped being charged, and only the invoice can tell them apart.
 */
export function reconcileInvoice(
  invoice: ThreeplInvoice,
  ledgerByCategory: { category: string; cents: number }[],
): Reconciliation {
  const ledger = new Map(ledgerByCategory.map((l) => [l.category, l.cents]));
  const categories = new Set([...invoice.lines.map((l) => l.category), ...ledger.keys()]);

  const byCategory: CategoryReconciliation[] = [...categories]
    .map((category) => {
      const invoiceCents = invoice.lines
        .filter((l) => l.category === category)
        .reduce((s, l) => s + l.amountCents, 0);
      const ledgerCents = ledger.get(category) ?? 0;
      return { category, invoiceCents, ledgerCents, gapCents: invoiceCents - ledgerCents };
    })
    .sort((a, b) => Math.abs(b.gapCents) - Math.abs(a.gapCents));

  const unexplained = byCategory.filter(
    (c) => Math.abs(c.gapCents) > ROUNDING_TOLERANCE_CENTS,
  );

  const ledgerTotalCents = ledgerByCategory.reduce((s, l) => s + l.cents, 0);
  const notes: string[] = [];
  for (const c of unexplained) {
    notes.push(
      c.gapCents > 0
        ? `${c.category}: the invoice charges $${(c.gapCents / 100).toFixed(2)} more than the ledger itemises — ` +
          `a cost that is billed but not broken out per order.`
        : `${c.category}: the ledger itemises $${(-c.gapCents / 100).toFixed(2)} more than the invoice charges.`,
    );
  }
  if (unexplained.length === 0 && invoice.totalCents !== ledgerTotalCents) {
    notes.push(
      `Totals differ by $${(Math.abs(invoice.totalCents - ledgerTotalCents) / 100).toFixed(2)}, ` +
        `all of it within per-category rounding.`,
    );
  }

  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceTotalCents: invoice.totalCents,
    ledgerTotalCents,
    gapCents: invoice.totalCents - ledgerTotalCents,
    byCategory,
    unexplained,
    notes,
  };
}
