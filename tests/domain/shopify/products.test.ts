import { describe, it, expect } from "vitest";
import {
  auditProductSeo, htmlToText, wordCount, slugify, findDuplicateDescriptions,
  PRODUCT_METAFIELD_KEYS, SEO_TITLE_MAX, SEO_DESCRIPTION_MAX, SEO_DESCRIPTION_MIN,
  type ProductSeoFacts,
} from "@/domain/shopify/products";

const product = (over: Partial<ProductSeoFacts> = {}): ProductSeoFacts => ({
  id: "gid://shopify/Product/1",
  title: "2026 Dated 8x10 Planner",
  handle: "2026-dated-8x10-planner",
  status: "ACTIVE",
  descriptionHtml: "<p>A dated planner with space for everything.</p>",
  seoTitle: "2026 Dated 8x10 Planner | Rad & Happy",
  seoDescription: "x".repeat(120),
  metafields: {},
  ...over,
});

describe("the metafields synced", () => {
  // Shopify will not return "all metafields" — absent from this list means
  // absent from the database, not empty in it.
  it("is exactly the five Matt named", () => {
    expect(PRODUCT_METAFIELD_KEYS).toEqual([
      "custom.overview_description", "custom.previous_description",
      "custom.faqs", "custom.features", "custom.class_overview",
    ]);
  });
});

describe("htmlToText", () => {
  it("strips tags so a word count measures copy, not markup", () => {
    expect(htmlToText("<p>Hello <strong>there</strong></p>")).toBe("Hello there");
  });

  it("decodes the entities Shopify emits", () => {
    expect(htmlToText("<p>Tara&rsquo;s pick &amp; more</p>")).toBe("Tara's pick & more");
  });

  it("drops script and style content rather than counting it as copy", () => {
    expect(htmlToText("<style>p{color:red}</style><p>Real copy</p>")).toBe("Real copy");
  });

  it("collapses whitespace", () => {
    expect(htmlToText("<p>a</p>\n\n   <p>b</p>")).toBe("a b");
  });

  it("returns empty for null", () => expect(htmlToText(null)).toBe(""));
});

describe("wordCount", () => {
  it("counts words", () => expect(wordCount("one two three")).toBe(3));
  it("is zero for empty", () => expect(wordCount("   ")).toBe(0));
});

describe("slugify", () => {
  it("matches Shopify's handle shape", () => {
    expect(slugify("2026 Dated 8x10 Planner")).toBe("2026-dated-8x10-planner");
  });
  it("expands an ampersand the way Shopify does", () => {
    expect(slugify("Rad & Happy")).toBe("rad-and-happy");
  });
  it("drops apostrophes rather than turning them into separators", () => {
    expect(slugify("Tara's Pick")).toBe("taras-pick");
  });
});

describe("auditProductSeo", () => {
  it("finds nothing wrong with a complete product", () => {
    expect(auditProductSeo(product()).issues).toEqual([]);
  });

  it("flags a missing SEO title", () => {
    expect(auditProductSeo(product({ seoTitle: null })).issues).toContain("no-seo-title");
  });

  it("flags a missing SEO description", () => {
    expect(auditProductSeo(product({ seoDescription: null })).issues).toContain("no-seo-description");
  });

  it("flags an SEO title Google will truncate", () => {
    expect(auditProductSeo(product({ seoTitle: "x".repeat(SEO_TITLE_MAX + 1) })).issues)
      .toContain("seo-title-too-long");
  });

  it("accepts a title exactly at the limit", () => {
    expect(auditProductSeo(product({ seoTitle: "x".repeat(SEO_TITLE_MAX) })).issues).toEqual([]);
  });

  it("flags a description that is too long and one that is too short", () => {
    expect(auditProductSeo(product({ seoDescription: "x".repeat(SEO_DESCRIPTION_MAX + 1) })).issues)
      .toContain("seo-description-too-long");
    expect(auditProductSeo(product({ seoDescription: "x".repeat(SEO_DESCRIPTION_MIN - 1) })).issues)
      .toContain("seo-description-too-short");
  });

  // A missing description and one four characters too long are not the same
  // problem, and a score would collapse them into one number.
  it("reports issues rather than a score", () => {
    const audit = auditProductSeo(product({ seoTitle: null, descriptionHtml: null }));
    expect(audit.issues).toEqual(expect.arrayContaining(["no-seo-title", "no-description"]));
  });

  it("counts description words after stripping markup", () => {
    expect(auditProductSeo(product({ descriptionHtml: "<p>one two three</p>" })).descriptionWords).toBe(3);
  });

  // A renamed product keeps its old URL, which is usually right. Only a handle
  // bearing no relation to the title is worth anyone's attention.
  it("does not flag a handle that mostly matches the title", () => {
    expect(auditProductSeo(product({ handle: "2026-dated-8x10-planner-doodle" })).issues)
      .not.toContain("handle-mismatch");
  });

  it("flags a handle with no relation to the title", () => {
    expect(auditProductSeo(product({ handle: "copy-of-untitled-product-3" })).issues)
      .toContain("handle-mismatch");
  });

  it("reports which metafields are set and which are not", () => {
    const audit = auditProductSeo(product({
      metafields: { "custom.faqs": "Q: ...", "custom.features": "  " },
    }));
    expect(audit.metafieldsPresent).toEqual(["custom.faqs"]);
    expect(audit.metafieldsMissing).toContain("custom.features");
    expect(audit.metafieldsMissing).toContain("custom.overview_description");
  });

  it("treats a null metafield bag as everything missing", () => {
    expect(auditProductSeo(product({ metafields: null })).metafieldsMissing)
      .toEqual(PRODUCT_METAFIELD_KEYS);
  });
});

describe("findDuplicateDescriptions", () => {
  it("groups products sharing identical copy", () => {
    const dupes = findDuplicateDescriptions([
      { id: "1", title: "A", descriptionHtml: "<p>Same</p>" },
      { id: "2", title: "B", descriptionHtml: "<p>Same</p>" },
      { id: "3", title: "C", descriptionHtml: "<p>Different</p>" },
    ]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].products.map((p) => p.title)).toEqual(["A", "B"]);
  });

  it("matches on text, so differing markup around identical copy still counts", () => {
    expect(findDuplicateDescriptions([
      { id: "1", title: "A", descriptionHtml: "<p>Same copy</p>" },
      { id: "2", title: "B", descriptionHtml: "<div><span>Same copy</span></div>" },
    ])).toHaveLength(1);
  });

  // Products with no description are not duplicates of each other.
  it("ignores products with no description", () => {
    expect(findDuplicateDescriptions([
      { id: "1", title: "A", descriptionHtml: null },
      { id: "2", title: "B", descriptionHtml: "" },
    ])).toEqual([]);
  });
});
