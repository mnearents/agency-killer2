/**
 * Parses the weekly shipping-label invoice ("Rad and Happy invoice Oct 19th -
 * Oct 25th 2026.pdf"), which bills postage per carrier for a week.
 *
 * This is the postage the Evobox fulfilment invoices do not carry: DHL
 * eCommerce, Cirro, USPS and FedEx labels, with a shipment count per carrier.
 * It has no per-order detail, so what it yields is a weekly total and an
 * average per shipment — never an order's own label cost.
 */

import { normaliseInvoiceDate } from "./parse-threepl-invoice";

export interface CarrierCharge {
  carrier: string;
  shipments: number;
  amountCents: number;
}

export interface CarrierInvoice {
  invoiceNumber: string;
  issued: string | null;
  periodStart: string;
  periodEnd: string;
  carriers: CarrierCharge[];
  shipments: number;
  totalCents: number;
}

export class CarrierInvoiceParseError extends Error {}

const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

export function isCarrierInvoice(lines: string[]): boolean {
  return lines.some((l) => /SUMMARY OF CHARGES BY CARRIER/i.test(l));
}

export function parseCarrierInvoice(lines: string[]): CarrierInvoice {
  const header = lines.map((l) => l.match(/^.*?(\d{1,2}\/\d{1,2}\/\d{4})\s+([A-Z0-9]{8,})\s+\$[\d,]+\.\d{2}\s*$/)).find(Boolean);
  if (!header) throw new CarrierInvoiceParseError("No invoice number and issue date found on the label invoice.");
  const period = lines.map((l) => l.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/)).find(Boolean);
  if (!period) throw new CarrierInvoiceParseError(`Invoice ${header[2]} names no shipment period.`);

  const start = lines.findIndex((l) => /SUMMARY OF CHARGES BY CARRIER/i.test(l));
  if (start < 0) throw new CarrierInvoiceParseError(`Invoice ${header[2]} has no carrier summary.`);

  const carriers: CarrierCharge[] = [];
  let printed: { shipments: number; cents: number } | null = null;
  for (const line of lines.slice(start + 1)) {
    const total = line.match(/^TOTAL\s+(\d+)\s+(\$[\d,]+\.\d{2})\s*$/);
    if (total) {
      printed = { shipments: Number(total[1]), cents: cents(total[2]) };
      break;
    }
    const m = line.match(/^(.+?)\s+(\d+)\s+(\$[\d,]+\.\d{2})\s*$/);
    if (m && !/^CARRIER\b/i.test(line)) carriers.push({ carrier: m[1].trim(), shipments: Number(m[2]), amountCents: cents(m[3]) });
  }
  if (carriers.length === 0 || !printed) {
    throw new CarrierInvoiceParseError(`Invoice ${header[2]}'s carrier summary could not be read.`);
  }
  const summed = carriers.reduce((s, c) => s + c.amountCents, 0);
  if (summed !== printed.cents) {
    throw new CarrierInvoiceParseError(
      `Invoice ${header[2]} does not add up: carriers sum to ${(summed / 100).toFixed(2)} but the total is ${(printed.cents / 100).toFixed(2)}.`,
    );
  }

  return {
    invoiceNumber: header[2],
    issued: normaliseInvoiceDate(header[1]),
    periodStart: normaliseInvoiceDate(period[1])!,
    periodEnd: normaliseInvoiceDate(period[2])!,
    carriers,
    shipments: printed.shipments,
    totalCents: printed.cents,
  };
}
