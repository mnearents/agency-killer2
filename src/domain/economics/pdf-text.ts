/**
 * PDF → text lines, using pdfjs. The only part of invoice handling that needs
 * a PDF library, kept alone so `parseInvoiceLines` can be tested against
 * fixture text.
 *
 * Items are grouped by their y coordinate because a PDF has no concept of a
 * line: "1.", the date, the description and each amount are separate text runs
 * that happen to share a baseline. Reading them in document order instead
 * interleaves columns and the line-item regex matches nothing — which would
 * surface as "the layout changed", not as a bug here.
 */

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function pdfToLines(data: Uint8Array): Promise<string[]> {
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const lines: string[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();

    const byBaseline = new Map<number, { x: number; text: string }[]>();
    for (const item of content.items) {
      const text = "str" in item ? item.str : "";
      if (!text || text.trim() === "") continue;
      const transform = (item as { transform: number[] }).transform;
      const y = Math.round(transform[5]);
      if (!byBaseline.has(y)) byBaseline.set(y, []);
      byBaseline.get(y)!.push({ x: transform[4], text });
    }

    for (const y of [...byBaseline.keys()].sort((a, b) => b - a)) {
      const line = byBaseline
        .get(y)!
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line !== "") lines.push(line);
    }
  }

  return lines;
}
