/**
 * Email image renderer — takes an HTML template + data, renders it
 * to a pixel-perfect image via Playwright.
 *
 * Templates live in templates/email/ and use {{mustache}} placeholders.
 * Output is 1200px wide JPG (2x of 600px email width).
 */

import { chromium, type Browser } from "playwright";
import path from "path";
import fs from "fs/promises";

const TEMPLATES_DIR = path.resolve("templates/email");
const RESOURCES_DIR = path.resolve("resources");
const OUTPUT_DIR = path.resolve("output/email");

export interface RenderOptions {
  /** Template file name (e.g., "hero-image") */
  template: string;
  /** Template variables to substitute */
  data: Record<string, string | undefined>;
  /** Output filename (without extension) */
  outputName: string;
}

export interface RenderResult {
  outputPath: string;
  width: number;
  height: number;
}

/**
 * Simple mustache-style template rendering.
 * Supports {{var}} and {{#var}}...{{/var}} conditional blocks.
 */
function renderTemplate(html: string, data: Record<string, string | undefined>): string {
  let result = html;

  // Handle conditional blocks: {{#key}}...{{/key}}
  result = result.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, key, content) => {
      const value = data[key];
      if (value && value.trim() !== "") {
        // Render the block content with variables substituted
        return renderTemplate(content, data);
      }
      return "";
    }
  );

  // Handle simple variable substitution: {{var}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return data[key] ?? "";
  });

  return result;
}

// Brand defaults
const BRAND_DEFAULTS: Record<string, string> = {
  backgroundColor: "#000000",
  headlineColor: "#ffffff",
  bodyColor: "#ffffff",
  buttonColor: "#F9FF00",
  buttonTextColor: "#000000",
  headlineFontSize: "102",
  fontsDir: RESOURCES_DIR,
  resourcesDir: RESOURCES_DIR,
};

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return _browser;
}

export async function renderEmailImage(options: RenderOptions): Promise<RenderResult> {
  const templatePath = path.join(TEMPLATES_DIR, `${options.template}.html`);
  const templateHtml = await fs.readFile(templatePath, "utf-8");

  // Merge brand defaults with provided data
  const data = { ...BRAND_DEFAULTS, ...options.data };

  // Convert local file paths to data URIs for Playwright
  for (const [key, value] of Object.entries(data)) {
    if (value && (value.endsWith(".jpg") || value.endsWith(".jpeg") || value.endsWith(".png"))) {
      try {
        const filePath = value.startsWith("/") ? value : path.resolve(value);
        const fileBuffer = await fs.readFile(filePath);
        const ext = path.extname(filePath).slice(1);
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
        data[key] = `data:${mime};base64,${fileBuffer.toString("base64")}`;
      } catch {
        // Leave as-is if file can't be read (might be a URL already)
      }
    }
  }

  // Convert font file:// references to data URIs
  const fontFiles = ["cgpr.woff2", "pp-ns.woff2", "pp-sm.woff2"];
  for (const fontFile of fontFiles) {
    const fontPath = path.join(RESOURCES_DIR, fontFile);
    try {
      const fontBuffer = await fs.readFile(fontPath);
      const dataUri = `data:font/woff2;base64,${fontBuffer.toString("base64")}`;
      data[`font_${fontFile.replace(/[.-]/g, "_")}`] = dataUri;
    } catch {
      // Font not found
    }
  }

  // Render template
  const html = renderTemplate(templateHtml, data);

  // Ensure output directory exists
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
  });

  // Load the rendered HTML
  await page.setContent(html, { waitUntil: "networkidle" });

  // Wait for fonts and images to load
  await page.waitForTimeout(1000);

  // Get the actual content height
  const bodyHeight = await page.evaluate(() => {
    const container = document.querySelector(".container");
    return container ? container.scrollHeight : document.body.scrollHeight;
  });

  // Resize viewport to match content
  await page.setViewportSize({ width: 1200, height: bodyHeight });

  // Screenshot as JPG
  const outputPath = path.join(OUTPUT_DIR, `${options.outputName}.jpg`);
  await page.screenshot({
    path: outputPath,
    type: "jpeg",
    quality: 90,
    fullPage: true,
  });

  await page.close();

  console.log(`[renderer] Rendered ${options.template} → ${outputPath} (1200x${bodyHeight})`);

  return {
    outputPath,
    width: 1200,
    height: bodyHeight,
  };
}

/**
 * Clean up the browser instance. Call on shutdown.
 */
export async function closeRenderer(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}
