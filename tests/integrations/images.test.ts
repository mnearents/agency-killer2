import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  inspectImage,
  resizeToJpeg,
  resizeToJpegWithin,
  drawLabel,
  readLabel,
  contactSheet,
  sheetLayout,
  sheetCell,
  SHEET_CELL,
  SHEET_LABEL_SCALE,
} from "@/integrations/images";

/** A solid image of the given size, as a JPEG unless said otherwise. */
const image = (width: number, height: number, format: "jpeg" | "png" = "jpeg", colour = { r: 200, g: 120, b: 40 }) =>
  sharp({ create: { width, height, channels: 3, background: colour } })[format]().toBuffer();

describe("inspectImage", () => {
  it("reads the size, the EXIF date the photo was taken and the camera", async () => {
    const data = await sharp(await image(300, 200))
      .withExif({ IFD0: { Make: "Apple", Model: "iPhone 15 Pro" }, IFD2: { DateTimeOriginal: "2026:10:09 14:36:32" } })
      .jpeg()
      .toBuffer();
    expect(await inspectImage(data)).toEqual({
      width: 300,
      height: 200,
      format: "jpeg",
      takenAt: "2026-10-09T14:36:32",
      camera: "Apple iPhone 15 Pro",
    });
  });

  it("does not repeat the make when the model already names it", async () => {
    const data = await sharp(await image(10, 10)).withExif({ IFD0: { Make: "Canon", Model: "Canon EOS R6" } }).jpeg().toBuffer();
    expect((await inspectImage(data)).camera).toBe("Canon EOS R6");
  });

  // A phone stores a portrait photo on its side and says so in EXIF.
  it("reports a rotated photo as it is displayed, portrait as portrait", async () => {
    const data = await sharp(await image(400, 300)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const facts = await inspectImage(data);
    expect([facts.width, facts.height]).toEqual([300, 400]);
  });

  it("has no date or camera for an image without EXIF", async () => {
    expect(await inspectImage(await image(50, 40, "png"))).toEqual({ width: 50, height: 40, format: "png", takenAt: null, camera: null });
  });

  it("throws on bytes that are not an image", async () => {
    await expect(inspectImage(Buffer.from("not an image"))).rejects.toThrow();
  });
});

describe("resizeToJpeg", () => {
  it("makes the longest side exactly the size asked for", async () => {
    const out = await resizeToJpeg(await image(3000, 2000), 2000);
    expect([out.width, out.height]).toEqual([2000, 1333]);
    const meta = await sharp(out.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2000, 1333]);
  });

  it("never enlarges a smaller image", async () => {
    const out = await resizeToJpeg(await image(720, 1280), 2000);
    expect([out.width, out.height]).toEqual([720, 1280]);
  });

  it("steps quality down until the file fits", async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 800 * 800 * 3 }, (_, i) => (i * 7919) % 251)), { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer();
    const roomy = await resizeToJpegWithin(noisy, 800, 10_000_000);
    expect(roomy.quality).toBe(85);
    const tight = await resizeToJpegWithin(noisy, 800, Math.floor(roomy.data.length * 0.8));
    expect(tight.quality).toBeLessThan(85);
    expect(tight.data.length).toBeLessThan(roomy.data.length);
  });
});

describe("labels", () => {
  it("draws text that reads back as itself", () => {
    expect(readLabel(drawLabel("#1234567890", 3), 3)).toBe("#1234567890");
  });

  it("refuses a character it cannot draw rather than drawing a different id", () => {
    expect(() => drawLabel("#12a", 2)).toThrow(/cannot draw "a"/);
  });
});

describe("contactSheet", () => {
  it("puts 24 thumbnails in one image, six across, each labelled with its id", async () => {
    const tiles = await Promise.all(
      Array.from({ length: 24 }, async (_, i) => ({ label: `#${101 + i}`, image: await image(400 + i * 10, 300, "jpeg", { r: i * 10, g: 255 - i * 10, b: 128 }) })),
    );
    const sheet = await contactSheet(tiles);
    const layout = sheetLayout(24);
    expect([layout.columns, layout.rows]).toEqual([6, 4]);
    expect([sheet.width, sheet.height]).toEqual([layout.width, layout.height]);

    const raw = await sharp(sheet.data).raw().toBuffer({ resolveWithObject: true });
    expect(raw.info.format).toBe("raw");
    // Read each label straight off the JPEG's pixels where the layout puts it.
    for (const index of [0, 5, 6, 23]) {
      const cell = sheetCell(index, layout.columns);
      const text = `#${101 + index}`;
      const label = drawLabel(text, SHEET_LABEL_SCALE);
      const left = cell.left + Math.floor((SHEET_CELL - label.width) / 2);
      const crop = await sharp(sheet.data).extract({ left, top: cell.labelTop, width: label.width, height: label.height }).removeAlpha().raw().toBuffer();
      expect(readLabel({ data: crop, width: label.width, height: label.height }, SHEET_LABEL_SCALE)).toBe(text);
    }
  });

  it("refuses an empty sheet", async () => {
    await expect(contactSheet([])).rejects.toThrow(/at least one/);
  });
});
