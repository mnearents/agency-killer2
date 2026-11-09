/**
 * The little formatting a written review uses — paragraphs, `- ` bullets,
 * numbered lines, **bold** and *italics* — parsed into blocks the page renders as React
 * elements. Nothing is ever treated as HTML, so markup in a review is shown
 * as text rather than run.
 */

export interface TextPart {
  text: string;
  bold: boolean;
  italic?: true;
}

export type Block =
  | { type: "p"; parts: TextPart[] }
  | { type: "ul"; items: TextPart[][] }
  | { type: "ol"; items: TextPart[][] };

function inline(text: string): TextPart[] {
  const parts: TextPart[] = [];
  // **bold**, or *italic* hugging its words — "5 * 3" is not emphasis.
  const re = /\*\*(.+?)\*\*|\*(?!\s)(.+?)(?<!\s)\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
    parts.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], bold: false, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts;
}

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function parseReviewText(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length > 0) blocks.push({ type: "p", parts: inline(paragraph.join(" ")) });
      paragraph = [];
    };
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (line === "") continue;
      const kind = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
      if (kind === null) {
        paragraph.push(line);
        continue;
      }
      flush();
      const item = inline(line.replace(kind === "ul" ? BULLET : NUMBERED, ""));
      const prev = blocks[blocks.length - 1];
      if (prev && prev.type === kind) prev.items.push(item);
      else blocks.push({ type: kind, items: [item] });
    }
    flush();
  }
  return blocks;
}
