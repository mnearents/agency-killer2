/**
 * Image measuring and resizing, on sharp (libvips).
 *
 * Local computation, not a service: nothing here touches the network. sharp is
 * a native module, so it is imported when first used rather than at load. The
 * portable MCP bundle (scripts/build-mcp.ts) leaves it out; there, a photo
 * tool says image processing is unavailable instead of the whole server
 * failing to start.
 *
 * Contact-sheet labels are drawn from a built-in pixel font rather than
 * rendered text. Text rendering depends on the fonts a machine has, and a
 * label drawn as empty boxes is a sheet nobody can refer back to.
 */

import exifReader from "exif-reader";

type Sharp = typeof import("sharp");

let loaded: Promise<Sharp> | null = null;

/** sharp, or a plain error saying it is not installed here. */
export async function loadSharp(): Promise<Sharp> {
  loaded ??= import("sharp").then(
    (m) => (m.default ?? m) as Sharp,
    (err) => {
      loaded = null;
      throw new Error(`image processing (sharp) is not available on this machine: ${err instanceof Error ? err.message : String(err)}`);
    },
  );
  return loaded;
}

export interface ImageFacts {
  /** As displayed: EXIF rotation applied, so a portrait phone photo is taller than wide. */
  width: number;
  height: number;
  format: string;
  /** EXIF DateTimeOriginal (else DateTimeDigitized), camera local time, "YYYY-MM-DDTHH:MM:SS". */
  takenAt: string | null;
  /** EXIF Make and Model, e.g. "Apple iPhone 15 Pro". */
  camera: string | null;
}

const exifTime = (d: unknown) =>
  d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 19) : null;

/** What the EXIF block says about when and with what. Unreadable EXIF is no EXIF. */
export function readExif(exif: Buffer | undefined): Pick<ImageFacts, "takenAt" | "camera"> {
  if (!exif || exif.length === 0) return { takenAt: null, camera: null };
  let tags: ReturnType<typeof exifReader>;
  try {
    tags = exifReader(exif);
  } catch {
    return { takenAt: null, camera: null };
  }
  // exif-reader reads EXIF's zoneless times as UTC, so the ISO string is the
  // camera's own clock reading, which is what is kept.
  const takenAt = exifTime(tags.Photo?.DateTimeOriginal) ?? exifTime(tags.Photo?.DateTimeDigitized);
  const make = typeof tags.Image?.Make === "string" ? tags.Image.Make.replace(/\0/g, "").trim() : "";
  const model = typeof tags.Image?.Model === "string" ? tags.Image.Model.replace(/\0/g, "").trim() : "";
  const camera = model && make && model.toLowerCase().startsWith(make.toLowerCase()) ? model : [make, model].filter(Boolean).join(" ");
  return { takenAt, camera: camera || null };
}

export async function inspectImage(data: Buffer): Promise<ImageFacts> {
  const sharp = await loadSharp();
  const meta = await sharp(data, { failOn: "none" }).metadata();
  if (!meta.width || !meta.height) throw new Error("the image has no readable dimensions");
  // Orientations 5-8 are a quarter turn: the stored pixels are on their side.
  const turned = (meta.orientation ?? 1) >= 5;
  return {
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
    format: meta.format ?? "unknown",
    ...readExif(meta.exif),
  };
}

export interface Jpeg {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * A JPEG whose longest side is `maxDimension`, or the original size when the
 * image is smaller — never enlarged. Upright (EXIF rotation applied), with any
 * transparency flattened onto white.
 */
export async function resizeToJpeg(data: Buffer, maxDimension: number, quality = 85): Promise<Jpeg> {
  const sharp = await loadSharp();
  const { data: out, info } = await sharp(data, { failOn: "none" })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer({ resolveWithObject: true });
  return { data: out, width: info.width, height: info.height };
}

/**
 * `resizeToJpeg`, stepping the quality down until the file is at most
 * `maxBytes`. An image larger than a client accepts is not seen at all.
 */
export async function resizeToJpegWithin(data: Buffer, maxDimension: number, maxBytes: number): Promise<Jpeg & { quality: number }> {
  let last: (Jpeg & { quality: number }) | null = null;
  for (const quality of [85, 75, 65, 55]) {
    last = { ...(await resizeToJpeg(data, maxDimension, quality)), quality };
    if (last.data.length <= maxBytes) return last;
  }
  return last!;
}

// ─── Labels ──────────────────────────────────────────────────────────

/** 5x7 glyphs: each row a 5-bit pattern, most significant bit on the left. */
const GLYPHS: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
  "#": [0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

export const LABEL_CHARACTERS = Object.keys(GLYPHS).join("");

/**
 * `text` drawn as raw RGB pixels, white on `background`, each font pixel a
 * `scale`-pixel square. Throws on a character the font does not have, rather
 * than drawing a label that reads as a different id.
 */
export function drawLabel(text: string, scale: number, background: [number, number, number] = [26, 26, 26]): { data: Buffer; width: number; height: number } {
  for (const ch of text) {
    if (!(ch in GLYPHS)) throw new Error(`cannot draw "${ch}" in a label; labels take ${LABEL_CHARACTERS}`);
  }
  const width = Math.max(1, (text.length * 6 - 1) * scale);
  const height = 7 * scale;
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(background, i * 3);
  [...text].forEach((ch, index) => {
    GLYPHS[ch].forEach((bits, row) => {
      for (let col = 0; col < 5; col++) {
        if (!(bits & (1 << (4 - col)))) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = (index * 6 + col) * scale + dx;
            const y = row * scale + dy;
            data.fill(255, (y * width + x) * 3, (y * width + x) * 3 + 3);
          }
        }
      }
    });
  });
  return { data, width, height };
}

/** Reads `drawLabel`'s pixels back to text. For tests: proves a label says what it should. */
export function readLabel(pixels: { data: Buffer; width: number; height: number }, scale: number): string {
  const lit = (x: number, y: number) => pixels.data[(y * pixels.width + x) * 3] > 128;
  const count = Math.round((pixels.width / scale + 1) / 6);
  let text = "";
  for (let index = 0; index < count; index++) {
    const rows = Array.from({ length: 7 }, (_, row) => {
      let bits = 0;
      for (let col = 0; col < 5; col++) {
        if (lit((index * 6 + col) * scale + Math.floor(scale / 2), row * scale + Math.floor(scale / 2))) bits |= 1 << (4 - col);
      }
      return bits;
    });
    const match = Object.entries(GLYPHS).find(([, g]) => g.every((b, i) => b === rows[i]));
    text += match ? match[0] : "?";
  }
  return text;
}

// ─── Contact sheets ──────────────────────────────────────────────────

export const SHEET_CELL = 320;
export const SHEET_LABEL_HEIGHT = 44;
export const SHEET_LABEL_SCALE = 4;
const SHEET_GAP = 8;
const SHEET_BACKGROUND = { r: 26, g: 26, b: 26 };

/** Where each tile goes: up to six across. */
export function sheetLayout(count: number): { columns: number; rows: number; width: number; height: number } {
  const columns = Math.max(1, Math.min(6, count));
  const rows = Math.max(1, Math.ceil(count / columns));
  return {
    columns,
    rows,
    width: columns * SHEET_CELL + (columns + 1) * SHEET_GAP,
    height: rows * (SHEET_CELL + SHEET_LABEL_HEIGHT) + (rows + 1) * SHEET_GAP,
  };
}

/** Where tile `index`'s picture and label sit. */
export function sheetCell(index: number, columns: number) {
  const left = SHEET_GAP + (index % columns) * (SHEET_CELL + SHEET_GAP);
  const top = SHEET_GAP + Math.floor(index / columns) * (SHEET_CELL + SHEET_LABEL_HEIGHT + SHEET_GAP);
  return { left, top, labelTop: top + SHEET_CELL + Math.floor((SHEET_LABEL_HEIGHT - 7 * SHEET_LABEL_SCALE) / 2) };
}

/**
 * One JPEG of the tiles in order, each fitted into a square cell with its
 * label centred beneath it.
 */
export async function contactSheet(tiles: { label: string; image: Buffer }[]): Promise<Jpeg> {
  if (tiles.length === 0) throw new Error("a contact sheet needs at least one image");
  const sharp = await loadSharp();
  const layout = sheetLayout(tiles.length);
  const composites: import("sharp").OverlayOptions[] = [];
  for (const [index, tile] of tiles.entries()) {
    const cell = sheetCell(index, layout.columns);
    const fitted = await sharp(tile.image, { failOn: "none" })
      .rotate()
      .resize({ width: SHEET_CELL, height: SHEET_CELL, fit: "contain", background: SHEET_BACKGROUND })
      .flatten({ background: SHEET_BACKGROUND })
      .toBuffer();
    composites.push({ input: fitted, left: cell.left, top: cell.top });
    const label = drawLabel(tile.label, SHEET_LABEL_SCALE);
    composites.push({
      input: label.data,
      raw: { width: label.width, height: label.height, channels: 3 },
      left: cell.left + Math.max(0, Math.floor((SHEET_CELL - label.width) / 2)),
      top: cell.labelTop,
    });
  }
  const { data, info } = await sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: SHEET_BACKGROUND } })
    .composite(composites)
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
