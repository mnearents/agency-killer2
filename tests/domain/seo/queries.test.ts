import { describe, it, expect } from "vitest";
import {
  crossesSessionBreak,
  SESSION_MEASUREMENT_BREAK,
  GSC_DIMENSIONS,
  SESSION_DIMENSIONS,
} from "@/domain/seo/queries";

describe("SESSION_MEASUREMENT_BREAK", () => {
  it("is the day Shopify's session counting changed", () => {
    expect(SESSION_MEASUREMENT_BREAK).toBe("2025-12-31");
  });
});

describe("crossesSessionBreak", () => {
  it("flags a window with days on both sides", () => {
    expect(crossesSessionBreak({ from: "2025-10-01", to: "2026-03-01" })).toBe(true);
  });

  it("does not flag a window entirely before the break", () => {
    expect(crossesSessionBreak({ from: "2025-10-01", to: "2025-12-30" })).toBe(false);
  });

  it("does not flag a window entirely after the break", () => {
    expect(crossesSessionBreak({ from: "2026-01-01", to: "2026-09-01" })).toBe(false);
  });

  // 2025-12-31 is itself the stepped day — 187% where the days before it sit
  // at 82-107% — so it is the first day of the NEW regime, not the last of the
  // old one.
  it("does not flag a window starting exactly on the break", () => {
    expect(crossesSessionBreak({ from: "2025-12-31", to: "2026-06-01" })).toBe(false);
  });

  it("flags a window ending exactly on the break, which does span both", () => {
    expect(crossesSessionBreak({ from: "2025-12-01", to: "2025-12-31" })).toBe(true);
  });

  it("flags the narrowest window that spans the change", () => {
    expect(crossesSessionBreak({ from: "2025-12-30", to: "2025-12-31" })).toBe(true);
  });

  it("does not flag the day before the break on its own", () => {
    expect(crossesSessionBreak({ from: "2025-12-30", to: "2025-12-30" })).toBe(false);
  });

  it("does not flag the break day on its own", () => {
    expect(crossesSessionBreak({ from: "2025-12-31", to: "2025-12-31" })).toBe(false);
  });
});

describe("the dimension vocabularies", () => {
  it("covers what Search Console stores", () => {
    expect(GSC_DIMENSIONS).toEqual(["total", "query", "page", "device", "country"]);
  });

  it("covers what the session sync stores", () => {
    expect(SESSION_DIMENSIONS).toEqual(["total", "referrer_source", "referrer_name", "landing_page"]);
  });
});

import { handleFromUrl } from "@/domain/seo/product-search";

describe("handleFromUrl", () => {
  it("extracts the handle from a product URL", () => {
    expect(handleFromUrl("https://radandhappy.com/products/color-happy-subscription"))
      .toBe("color-happy-subscription");
  });

  it("ignores a query string and fragment", () => {
    expect(handleFromUrl("https://radandhappy.com/products/rad-club?variant=1#buy")).toBe("rad-club");
  });

  it("ignores a trailing path segment", () => {
    expect(handleFromUrl("https://radandhappy.com/products/rad-club/reviews")).toBe("rad-club");
  });

  it("lowercases, since handles are lowercase", () => {
    expect(handleFromUrl("https://radandhappy.com/products/Rad-Club")).toBe("rad-club");
  });

  it("decodes an escaped handle", () => {
    expect(handleFromUrl("https://radandhappy.com/products/rad%2Dclub")).toBe("rad-club");
  });

  // Collections, pages, blogs and the home page have no product behind them.
  // "This product gets no traffic" and "this URL is not a product" are
  // different answers and must not be the same null.
  it("returns null for a URL that is not a product page", () => {
    for (const url of [
      "https://radandhappy.com/",
      "https://radandhappy.com/collections/planners",
      "https://radandhappy.com/pages/coloring-page",
      "https://radandhappy.com/blogs/news/a-post",
    ]) {
      expect(handleFromUrl(url), url).toBeNull();
    }
  });

  it("returns null when the path ends at /products/", () => {
    expect(handleFromUrl("https://radandhappy.com/products/")).toBeNull();
  });
});
