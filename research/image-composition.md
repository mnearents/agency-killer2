# Programmatic Image Composition for Email Marketing Creative

## The Question

Which approach gives pixel-perfect typographic precision for email marketing images — text placement with exact fonts, SVG overlays, and image layering — suitable for a designer (Tara) who is "very picky about typography, alignment, spacing"?

## Context

- Stationery brand, image-based email marketing
- Emails are essentially designed images: text, product photos, buttons, brand elements
- Currently designed manually in Figma/Canva
- Volume: 5-15 emails/month
- Must run in Node.js on Railway (512MB-1GB memory)
- Same input must produce identical output every time

---

## 1. Sharp (libvips)

### What it is
Sharp is a high-performance Node.js image processing library backed by libvips. It excels at resizing, format conversion, and compositing raster images.

### Typography capabilities
Sharp itself has **no native text rendering API**. The standard workaround is to construct an SVG string containing `<text>` elements and composite it onto an image using `sharp.composite([{ input: Buffer.from(svgString), ... }])`.

This means text rendering is delegated to **librsvg** (the SVG renderer bundled with libvips). Typography control is therefore limited to what SVG text elements and librsvg support:

- **Custom fonts**: Possible, but painful. Fonts must be installed at the OS level (in `/usr/share/fonts` or equivalent) or referenced via `@font-face` in the SVG. On Railway (Docker), this means adding fonts to the container image. librsvg's font resolution can be finicky — it uses fontconfig, so the font must be correctly registered.
- **Letter-spacing**: SVG supports `letter-spacing` attribute, and librsvg generally respects it. However, fine-tuning is less predictable than CSS.
- **Line-height**: SVG text uses `<tspan>` elements with `dy` attributes for manual line breaks. There is no automatic line wrapping — you must calculate line breaks yourself.
- **Font-weight**: Supported if the font file for that weight is installed.
- **Text alignment**: Manual. SVG `text-anchor` gives start/middle/end, but multi-line centering requires manual `x` positioning per `<tspan>`.

### Strengths
- Extremely fast (sub-100ms for most operations)
- Low memory (~50-80MB for typical operations)
- Excellent image compositing (product photo layering, blend modes)
- Native SVG overlay support (brand icons, decorative elements work well)
- Deterministic output (same input = same output)
- Battle-tested in production at scale

### Weaknesses
- **Text rendering is the Achilles' heel.** You are writing raw SVG text elements, manually computing line breaks, and relying on librsvg's text rendering — which does not match browser-quality typography.
- No automatic text wrapping or layout engine
- Multi-line text with precise spacing requires significant manual calculation
- librsvg's font rendering quality is decent but not as polished as browser or Skia rendering
- Custom font loading on Railway requires Docker image customization
- SVG text `letter-spacing` support in librsvg has had historical bugs; sub-pixel precision can vary

### Typography precision verdict: **5/10**
Sharp is the wrong tool for typography-heavy work. It is an image processing library, not a layout engine. For a designer who notices 1px misalignment, the manual SVG text approach will be a constant source of friction. However, it is excellent as the *final compositing step* (taking rendered text as a pre-rendered image and layering it with photos).

---

## 2. Puppeteer / Playwright (Headless Chrome)

### What it is
Launches a headless Chromium browser, renders HTML/CSS, and screenshots the result to PNG/JPG.

### Typography capabilities
This is **the gold standard** for typography control because you get the full CSS engine:

- **Custom fonts**: `@font-face` with embedded font files (base64 or file:// URLs). Full support for .woff2, .otf, .ttf. Fonts render exactly as they would in Chrome.
- **Letter-spacing**: Full CSS `letter-spacing` support, including sub-pixel values (`0.02em`, `0.5px`)
- **Line-height**: Full CSS `line-height` support, unitless, px, em, percentage
- **Font-weight**: Full variable font support, numeric weights (100-900)
- **Text alignment**: Full CSS — `text-align`, flexbox `justify-content`/`align-items`, grid layout, absolute positioning, transforms
- **Advanced typography**: `font-feature-settings` (ligatures, small caps, stylistic alternates), `text-transform`, `word-spacing`, `text-indent`, `font-variant`, `text-rendering: optimizeLegibility`

### Strengths
- **Pixel-perfect match to browser rendering** — what Tara sees in Chrome is what the output looks like
- Full CSS layout engine (flexbox, grid, absolute positioning)
- Trivial to prototype — build the template in a browser, then screenshot it
- SVG elements render natively in HTML
- Image layering via CSS (`background-image`, `<img>`, `position: absolute`)
- Hot-reloadable templates during development (just HTML/CSS files)
- Tara could preview templates in a browser before generation
- Massive ecosystem of CSS knowledge, tooling, and examples

### Weaknesses
- **Memory**: Chromium uses 150-300MB per instance. On a 512MB Railway container, this is tight but workable for sequential generation. On 1GB, comfortable. A single browser instance can be reused across multiple renders.
- **Startup time**: Cold start is 2-5 seconds. Warm renders (reusing browser instance) are 200-500ms.
- **Docker image size**: Chromium adds ~400MB to the container. Playwright's `playwright install chromium` or `@sparticuz/chromium` (a minimal Chromium build, ~50MB compressed) can help.
- **Reliability**: Headless Chrome is mature and reliable, but it is a large dependency. Browser crashes (rare but possible) need graceful handling.
- **Deterministic output**: Nearly deterministic, but sub-pixel rendering can vary between Chromium versions. Pinning the Chromium version (which Playwright does by default) solves this.
- **Font rendering**: Chrome uses Skia, which produces high-quality anti-aliased text. On Linux (Railway), it uses FreeType + fontconfig. Font rendering on Linux can differ slightly from macOS — but it is consistent within the same environment.

### Railway-specific considerations
- Use `@sparticuz/chromium` or Playwright's bundled Chromium to avoid needing system Chrome
- Set `--no-sandbox` flag (required in most containerized environments)
- Reuse a single browser instance via a singleton pattern to avoid repeated cold starts
- For 5-15 emails/month, the overhead is negligible — each render takes <1 second
- Memory is the main concern: keep one browser instance, one page, render sequentially

### Typography precision verdict: **10/10**
Unmatched. Full CSS typography is exactly what a designer expects. If Tara can describe it in CSS, it will render that way. This is the only approach where the rendering engine is the same one humans use to view web content.

---

## 3. Satori + Sharp

### What it is
Vercel's Satori converts React JSX (with inline styles) to SVG. It implements its own layout engine (based on Yoga, Facebook's flexbox implementation) and its own text shaping engine. The SVG output is then rasterized to PNG via Sharp (or `@resvg/resvg-js` for better quality).

### Typography capabilities
Satori supports a **subset** of CSS, focused on layout and text:

- **Custom fonts**: Yes. Fonts are loaded as ArrayBuffers and passed to the Satori options. Satori handles font shaping internally (using an embedded OpenType parser). This is actually easier than Puppeteer — no system font installation needed.
- **Letter-spacing**: Supported via `letterSpacing` style property.
- **Line-height**: Supported via `lineHeight`.
- **Font-weight**: Supported. Multiple font files can be registered for different weights.
- **Text alignment**: `textAlign` (left, center, right, justify) is supported.
- **Flexbox**: Full flexbox layout (powered by Yoga). `display: flex`, `justifyContent`, `alignItems`, `flexWrap`, `gap`, etc.

### Supported CSS properties (text-related)
`color`, `fontSize`, `fontFamily`, `fontWeight`, `fontStyle`, `textAlign`, `textTransform`, `textDecoration`, `textShadow`, `lineHeight`, `letterSpacing`, `wordBreak`, `textOverflow`, `whiteSpace`, `opacity`

### Not supported / limited
- **No `font-feature-settings`** — no ligatures, stylistic alternates, small caps via OpenType features
- **No `text-indent`**
- **No CSS Grid** — flexbox only
- **No `position: absolute`** in all contexts (partial support, some edge cases break)
- **No `transform`** on text
- **No `word-spacing`**
- **No variable fonts** — each weight needs a separate font file
- **Limited `background-image`** support — gradient backgrounds work, but not arbitrary image backgrounds in all contexts
- **Image handling**: `<img>` tags work (with base64 or URL sources), but images are embedded in the SVG; complex layering can be tricky

### Strengths
- **No browser dependency** — runs in pure Node.js, ~30-50MB memory
- Fast: renders in 10-50ms for typical compositions
- Font loading is clean (ArrayBuffer, no system installation)
- Flexbox layout handles most alignment needs
- React JSX templating is developer-friendly
- Deterministic output
- Actively maintained by Vercel (used for `next/og` — Open Graph image generation)

### Weaknesses
- **CSS subset is limiting.** For simple compositions (heading + subheading + product image), it works great. For complex layouts matching Figma-level designs, you will hit walls.
- **Text shaping quality**: Satori's built-in text shaper is good but not Chrome-grade. Complex scripts, advanced OpenType features, and edge cases in kerning may differ from browser rendering.
- **SVG-to-PNG pipeline**: The default Sharp rasterization (via librsvg) can lose quality. **Use `@resvg/resvg-js` instead** — it uses Rust's resvg, which produces much better output (proper anti-aliasing, correct font rendering from the embedded font data in the SVG).
- **Image compositing**: Satori can include images, but for complex layering (product photo background with text overlay with semi-transparent gradient), it is less intuitive than CSS `position: absolute` + `z-index`.
- **Debugging**: When a layout breaks, debugging Satori's flexbox interpretation is harder than debugging CSS in Chrome DevTools.

### Important: Satori + resvg-js vs Satori + Sharp
- `@resvg/resvg-js`: Rust-based SVG renderer. Produces high-quality rasterization with proper font embedding. **This is the recommended pipeline.**
- Sharp (via librsvg): May not render Satori's SVG output correctly, especially for embedded fonts. Text may fall back to system fonts.

### Typography precision verdict: **7/10**
Good for straightforward layouts. The flexbox model handles alignment well, and letter-spacing/line-height work. But the CSS subset means some design patterns require workarounds, and the lack of `font-feature-settings` and variable fonts limits typographic sophistication. For a "very picky" designer, the gap between "what CSS can do" and "what Satori supports" will be noticeable when attempting complex compositions.

---

## 4. Cloudinary

### What it is
A SaaS platform for image and video management. Offers URL-based image transformations, including text overlays.

### Typography capabilities
Cloudinary's text overlay system uses URL parameters to place text on images:

- **Custom fonts**: Cloudinary supports ~800 Google Fonts out of the box. Custom font upload is available on paid plans — you upload .ttf/.otf/.woff files via the Media Library or API. Once uploaded, fonts are referenced by their registered name.
- **Letter-spacing**: Supported via the `letter_spacing` parameter. Integer pixel values.
- **Line-height**: Supported via the `line_spacing` parameter.
- **Font-weight**: Limited to what the font file provides. Bold/normal are standard; numeric weights depend on having the appropriate font file uploaded.
- **Text alignment**: `text_align` parameter: left, center, right, justify.
- **Positioning**: Gravity-based (9-point grid: north, south, east, west, center, and combinations) plus `x`/`y` pixel offsets. This gives precise placement.

### Strengths
- **No infrastructure to manage** — it is a URL. No server-side rendering.
- Fast CDN delivery of generated images
- Image layering is a core feature (multiple overlay transformations chained)
- SVG overlay possible (upload SVG as an asset, use as overlay)
- Generous free tier: 25 monthly transformations credits + 25GB storage/bandwidth (which is ample for 5-15 emails/month)
- Deterministic (same URL = same image, cached)

### Weaknesses
- **Typography control is coarse.** Letter-spacing is integer pixels only (no sub-pixel). Line-height control is basic. No `font-feature-settings`, no `text-transform`, no `text-shadow` with fine control.
- **Custom font upload process** is clunky: upload via dashboard or API, wait for processing, reference by name. Font rendering quality depends on Cloudinary's internal renderer.
- **Layout is gravity + offset based**, not a real layout engine. Centering text within a specific region requires manual x/y calculation. No flexbox, no automatic alignment relative to other elements.
- **Complex multi-element compositions** (product photo + heading + subheading + CTA button + decorative SVG) require chaining many transformation parameters in a single URL — this becomes unwieldy and hard to maintain.
- **Vendor lock-in**: Templates are Cloudinary URLs, not portable code.
- **Debugging**: When text placement is off by 2px, adjusting means tweaking URL parameters and regenerating — slow iteration loop compared to CSS in a browser.
- **Pricing risk**: The free tier is likely sufficient for 5-15 emails/month, but if each email involves multiple image variants (A/B testing, different sizes), transformation credits can add up. Paid plans start at ~$89/month.

### Typography precision verdict: **4/10**
Cloudinary is built for "good enough" text-on-image, not pixel-perfect typography. Integer-only letter-spacing, gravity-based positioning, and limited font controls will frustrate a designer who cares about sub-pixel alignment. It is better suited for dynamic thumbnails or social media cards than precision email creative.

---

## 5. node-canvas (Cairo) / skia-canvas

### What it is
`canvas` (node-canvas) provides the HTML5 Canvas API in Node.js, backed by Cairo + Pango for rendering. `skia-canvas` is a newer alternative backed by Google's Skia rendering engine (the same engine Chrome uses).

### Typography capabilities — node-canvas (Cairo/Pango)

- **Custom fonts**: `registerFont('/path/to/font.ttf', { family: 'BrandFont', weight: 'bold' })` — straightforward API.
- **Font rendering**: Pango handles text shaping. Quality is good for Latin scripts. Pango supports OpenType features, kerning, and complex scripts.
- **Letter-spacing**: **Not natively supported by the Canvas API.** Must be implemented manually by drawing each character individually with calculated offsets — fragile and slow.
- **Line-height**: Not a Canvas API concept. Manual calculation of `y` offsets for each line.
- **Text alignment**: `ctx.textAlign` supports left/right/center/start/end. But only for single-line `fillText()` calls.
- **Multi-line text**: Not supported natively. You must split text, measure each line with `ctx.measureText()`, and position manually.

### Typography capabilities — skia-canvas

- **Custom fonts**: `FontLibrary.use('BrandFont', ['/path/to/font.ttf'])` — clean API.
- **Font rendering**: Skia produces the same rendering quality as Chrome (it is the same engine). Anti-aliasing, hinting, and sub-pixel rendering are excellent.
- **Letter-spacing**: Still not a Canvas API native, but skia-canvas may offer extensions. Generally still requires manual character-by-character rendering.
- **Line-height**: Manual, same limitation as node-canvas.
- **Text wrapping**: skia-canvas has some extended text wrapping support beyond standard Canvas API, but it is limited.

### Strengths
- **Direct pixel control** — you can place anything anywhere with exact coordinates
- **node-canvas**: Mature, widely used, well-documented. ~60-100MB memory.
- **skia-canvas**: Chrome-quality font rendering (Skia engine). ~80-120MB memory.
- Custom font loading is simple in both
- Image compositing via `drawImage()` is straightforward
- SVG rendering: node-canvas has limited SVG support; skia-canvas has better SVG support
- Deterministic output
- No external service dependency

### Weaknesses
- **Enormous amount of manual layout code.** There is no layout engine. Every element (heading, subheading, product image, CTA, decorative element) must be manually positioned with x/y coordinates. Multi-line text requires manual line breaking, measurement, and positioning.
- **No letter-spacing** in the Canvas API — implementing it properly (with correct kerning pair adjustments) is a mini-project.
- **Template maintenance nightmare.** Each email template is hundreds of lines of imperative drawing code. Adding a new element means recalculating positions of everything else. This is the antithesis of declarative layout.
- **node-canvas native compilation**: Requires Cairo, Pango, and libjpeg as system dependencies. On Railway (Docker), this means installing native libraries. The `canvas` npm package ships prebuilt binaries for common platforms, but Docker builds can be slow.
- **skia-canvas**: Smaller community, less battle-tested. Native compilation can be tricky in some environments.

### Typography precision verdict: **6/10 (node-canvas) / 7/10 (skia-canvas)**
You *can* achieve pixel-perfect placement because you control every coordinate. But the cost is massive: you are building a layout engine from scratch. Letter-spacing alone requires manual per-character rendering. For 5-15 complex email templates per month with a picky designer iterating on spacing, this approach creates an unsustainable maintenance burden.

---

## Comparison Matrix

| Criterion | Sharp (libvips) | Puppeteer/Playwright | Satori + resvg | Cloudinary | node-canvas / skia-canvas |
|---|---|---|---|---|---|
| **Typography precision** | 5/10 | 10/10 | 7/10 | 4/10 | 6-7/10 |
| **Custom fonts** | Hard (OS-level) | Easy (@font-face) | Easy (ArrayBuffer) | Medium (upload) | Easy (registerFont) |
| **Letter-spacing** | SVG attr (buggy) | Full CSS | Supported | Integer px only | Manual per-char |
| **Line-height** | Manual tspan dy | Full CSS | Supported | Basic | Manual |
| **Font features** | None | Full | None | None | Pango (partial) |
| **Layout engine** | None | CSS (flex/grid/abs) | Flexbox only | Gravity + offset | None |
| **SVG overlay** | Excellent | Native HTML/SVG | Via JSX | Upload as asset | Limited/Good |
| **Image layering** | Excellent | Full CSS | Limited | Good | drawImage() |
| **Memory footprint** | ~50-80MB | ~150-300MB | ~30-50MB | 0 (SaaS) | ~60-120MB |
| **Speed per image** | <100ms | 200-500ms (warm) | 10-50ms | Network latency | 50-200ms |
| **Railway viability** | Excellent | Good (1GB OK) | Excellent | Excellent | Good |
| **Template authoring** | SVG strings | HTML/CSS files | React JSX | URL params | Imperative code |
| **Designer preview** | None | Open in browser | Build preview tool | URL in browser | Build preview tool |
| **Deterministic** | Yes | Yes (pin version) | Yes | Yes | Yes |
| **Maintenance burden** | High (manual layout) | Low | Medium | Medium | Very High |

---

## Recommendation

### Primary: Puppeteer/Playwright

**For a designer who is "very picky about typography, alignment, spacing," Puppeteer/Playwright is the clear winner.** Here is why:

1. **Full CSS typography** — every property Tara expects from Figma/Canva has a direct CSS equivalent. Letter-spacing, line-height, font-weight, font-feature-settings, text-transform, and more.

2. **Designer-friendly workflow** — templates are HTML/CSS files that Tara can preview in a browser. She can open Chrome DevTools, adjust spacing in real time, and see exactly what the output will look like. No other approach offers this.

3. **Low maintenance** — CSS is declarative. Adding a new element or adjusting spacing means changing a CSS value, not recalculating coordinate offsets.

4. **Proven pattern** — headless Chrome for image generation is a well-established pattern used by countless services (OG image generators, PDF renderers, screenshot APIs).

5. **Railway feasibility** — at 5-15 emails/month, the memory overhead is irrelevant. A 1GB Railway container handles this trivially. Even a 512MB container works if you keep one browser instance and render sequentially.

### Recommended architecture

```
Template (HTML/CSS/custom fonts)
       |
       v
Playwright (headless Chromium)
       |
       v
  PNG screenshot
       |
       v
Sharp (optional: resize, optimize, format conversion)
       |
       v
  Final PNG for email
```

- **Playwright over Puppeteer**: Playwright bundles its own Chromium, handles browser lifecycle more cleanly, and has better TypeScript support. It also pins the Chromium version, ensuring deterministic rendering.
- **Sharp as a post-processor**: Use Sharp only for final optimization (compression, resizing for different email client widths) — not for text rendering.
- **Font loading**: Bundle .woff2 font files in the project. Reference them via `@font-face` in the HTML template with `file://` or base64-encoded URLs. Playwright supports `page.addStyleTag()` for injecting font declarations.
- **Template structure**: Each email type is an HTML file with CSS variables for brand colors, spacing, and font sizes. Product images are injected as `<img>` elements or CSS `background-image`. SVG brand elements are inlined.

### Runner-up: Satori + resvg-js

If Railway memory becomes a hard constraint (strict 512MB, other services competing), Satori is a strong second choice. Its flexbox layout and typography support cover 80% of what a picky designer needs. The gap versus Puppeteer:

- No `font-feature-settings` (ligatures, small caps)
- No CSS Grid
- Limited `position: absolute` (some edge cases)
- No browser-based preview (must build a preview tool or use Vercel's OG playground)
- Debugging layout issues is harder than Chrome DevTools

For straightforward email layouts (centered text, product image, CTA button), Satori is sufficient. For complex compositions with overlapping elements, decorative positioning, or advanced typography, it will frustrate.

### What to avoid

- **Sharp alone for text**: Too manual, too fragile, typography quality insufficient for a picky designer.
- **Cloudinary for this use case**: Not enough typographic control. Better suited for dynamic thumbnails, not brand-precision email creative.
- **node-canvas/skia-canvas**: The raw Canvas API requires too much imperative layout code. Every template becomes hundreds of lines of coordinate math. Unsustainable for iterative design work.

---

## Implementation sketch (Playwright)

```typescript
import { chromium, Browser } from 'playwright';
import sharp from 'sharp';
import path from 'path';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-gpu'],
    });
  }
  return browser;
}

interface EmailImageOptions {
  templatePath: string;       // path to HTML template
  data: Record<string, any>;  // dynamic content (text, image URLs)
  width: number;              // output width in pixels
  height: number;             // output height in pixels
}

async function generateEmailImage(options: EmailImageOptions): Promise<Buffer> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Set viewport to exact output dimensions
    await page.setViewportSize({
      width: options.width,
      height: options.height,
    });

    // Load the HTML template
    await page.goto(`file://${options.templatePath}`, {
      waitUntil: 'networkidle',
    });

    // Inject dynamic data (product images, text, etc.)
    await page.evaluate((data) => {
      // Template uses data attributes or a global render function
      // e.g., document.querySelector('[data-field="headline"]').textContent = data.headline;
      (window as any).__renderEmail?.(data);
    }, options.data);

    // Wait for fonts and images to load
    await page.waitForLoadState('networkidle');

    // Screenshot the page
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
    });

    // Optional: optimize with Sharp
    const optimized = await sharp(screenshot)
      .png({ quality: 95, compressionLevel: 9 })
      .toBuffer();

    return optimized;
  } finally {
    await page.close();
  }
}
```

### Template example (HTML/CSS)

```html
<!DOCTYPE html>
<html>
<head>
<style>
  @font-face {
    font-family: 'BrandSerif';
    src: url('./fonts/BrandSerif-Regular.woff2') format('woff2');
    font-weight: 400;
  }
  @font-face {
    font-family: 'BrandSerif';
    src: url('./fonts/BrandSerif-Bold.woff2') format('woff2');
    font-weight: 700;
  }
  @font-face {
    font-family: 'BrandSans';
    src: url('./fonts/BrandSans-Regular.woff2') format('woff2');
    font-weight: 400;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    width: 600px;
    height: 900px;
    overflow: hidden;
    background: #f5f0eb;
  }

  .hero-image {
    width: 100%;
    height: 400px;
    object-fit: cover;
  }

  .content {
    padding: 40px 48px;
    text-align: center;
  }

  .headline {
    font-family: 'BrandSerif', serif;
    font-weight: 700;
    font-size: 32px;
    line-height: 1.2;
    letter-spacing: 0.02em;
    color: #2c2c2c;
    margin-bottom: 16px;
  }

  .subheadline {
    font-family: 'BrandSans', sans-serif;
    font-weight: 400;
    font-size: 14px;
    line-height: 1.6;
    letter-spacing: 0.04em;
    color: #666;
    text-transform: uppercase;
    margin-bottom: 32px;
  }

  .cta {
    display: inline-block;
    font-family: 'BrandSans', sans-serif;
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #fff;
    background: #2c2c2c;
    padding: 14px 40px;
    text-decoration: none;
  }

  .brand-mark {
    position: absolute;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
  }
</style>
</head>
<body>
  <img class="hero-image" data-field="heroImage" src="" />
  <div class="content">
    <h1 class="headline" data-field="headline"></h1>
    <p class="subheadline" data-field="subheadline"></p>
    <a class="cta" data-field="ctaText" href="#"></a>
  </div>
  <!-- SVG brand mark -->
  <div class="brand-mark">
    <svg width="40" height="40" viewBox="0 0 40 40">
      <!-- brand icon SVG here -->
    </svg>
  </div>
</body>
</html>
```

---

## Cost and resource summary

| Approach | Railway cost impact | External service cost | Dev effort to MVP |
|---|---|---|---|
| Puppeteer/Playwright | +200-300MB RAM | $0 | 2-3 days |
| Satori + resvg-js | +30-50MB RAM | $0 | 2-3 days |
| Sharp (text via SVG) | +50MB RAM | $0 | 4-5 days (manual layout) |
| Cloudinary | None | $0-89/mo | 1-2 days |
| node-canvas | +80-120MB RAM | $0 | 5-7 days (manual layout) |

For 5-15 emails/month, the additional Railway cost for Playwright's memory footprint is negligible (likely $0-5/month on Railway's usage-based pricing).

---

## Final verdict

**Use Playwright + Sharp.** Playwright renders the HTML/CSS template to a pixel-perfect screenshot. Sharp handles post-processing (compression, resizing). Templates are HTML/CSS files that a designer can preview in any browser.

This is the only approach where "what you see in the browser is what you get in the email image" — which is exactly what a typography-obsessive designer needs. Every other approach requires compromises that will surface as friction when Tara says "the letter-spacing on that headline needs to be 0.03em tighter."
