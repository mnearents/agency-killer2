/**
 * Product copy, SEO fields and metafields (#13-adjacent, product SEO work).
 *
 * Pure. The sync sequences these; the MCP tools read them.
 */

/**
 * The metafields worth syncing, named by Matt.
 *
 * Shopify will not return "all metafields" — the API takes identifiers — so a
 * namespace absent from this list is absent from the database, not empty in
 * it. Adding one here is what makes it visible anywhere.
 */
export const PRODUCT_METAFIELDS = [
  { namespace: "custom", key: "overview_description" },
  { namespace: "custom", key: "previous_description" },
  { namespace: "custom", key: "faqs" },
  { namespace: "custom", key: "features" },
  { namespace: "custom", key: "class_overview" },
] as const;

export const PRODUCT_METAFIELD_KEYS = PRODUCT_METAFIELDS.map((m) => `${m.namespace}.${m.key}`);

/**
 * Shopify's own guidance, and what Google will actually render.
 *
 * These are advisory: a title over the limit is truncated in the SERP, not
 * rejected. Reported so the length is judged, never silently rewritten.
 */
export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 160;
export const SEO_DESCRIPTION_MIN = 70;

export interface ProductSeoFacts {
  id: string;
  title: string;
  handle: string;
  status: string;
  descriptionHtml: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  metafields: Record<string, string> | null;
}

export type SeoIssue =
  | "no-seo-title"
  | "no-seo-description"
  | "seo-title-too-long"
  | "seo-description-too-long"
  | "seo-description-too-short"
  | "no-description"
  | "handle-mismatch";

export interface ProductSeoAudit {
  id: string;
  title: string;
  handle: string;
  issues: SeoIssue[];
  seoTitleLength: number | null;
  seoDescriptionLength: number | null;
  descriptionWords: number;
  metafieldsPresent: string[];
  metafieldsMissing: string[];
}

/** Strips tags so a word count measures copy rather than markup. */
export function htmlToText(html: string | null): string {
  if (html === null) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;|&apos;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** A rough slug, for comparing a handle against its title. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * What is wrong with one product's SEO.
 *
 * Returns issues rather than a score. A score collapses "no meta description
 * at all" and "a meta description four characters too long" into one number,
 * and only one of those is worth anybody's afternoon.
 */
export function auditProductSeo(
  product: ProductSeoFacts,
  expectedMetafields: string[] = PRODUCT_METAFIELD_KEYS,
): ProductSeoAudit {
  const issues: SeoIssue[] = [];
  const text = htmlToText(product.descriptionHtml);
  const words = wordCount(text);

  if (product.seoTitle === null) issues.push("no-seo-title");
  else if (product.seoTitle.length > SEO_TITLE_MAX) issues.push("seo-title-too-long");

  if (product.seoDescription === null) issues.push("no-seo-description");
  else {
    if (product.seoDescription.length > SEO_DESCRIPTION_MAX) issues.push("seo-description-too-long");
    else if (product.seoDescription.length < SEO_DESCRIPTION_MIN) issues.push("seo-description-too-short");
  }

  if (words === 0) issues.push("no-description");

  // Only worth flagging when the handle bears no relation to the title — a
  // product renamed after launch keeps its old URL, which is usually correct
  // and occasionally a leftover from a typo nobody fixed.
  const expectedHandle = slugify(product.title);
  if (expectedHandle !== "" && product.handle !== expectedHandle) {
    const handleWords = new Set(product.handle.split("-").filter(Boolean));
    const titleWords = expectedHandle.split("-").filter(Boolean);
    const overlap = titleWords.filter((w) => handleWords.has(w)).length;
    if (titleWords.length > 0 && overlap / titleWords.length < 0.5) issues.push("handle-mismatch");
  }

  const present = expectedMetafields.filter(
    (k) => typeof product.metafields?.[k] === "string" && product.metafields[k].trim() !== "",
  );

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    issues,
    seoTitleLength: product.seoTitle === null ? null : product.seoTitle.length,
    seoDescriptionLength: product.seoDescription === null ? null : product.seoDescription.length,
    descriptionWords: words,
    metafieldsPresent: present,
    metafieldsMissing: expectedMetafields.filter((k) => !present.includes(k)),
  };
}

/** Products sharing identical description copy — usually a paste that stuck. */
export function findDuplicateDescriptions(
  products: { id: string; title: string; descriptionHtml: string | null }[],
): { text: string; products: { id: string; title: string }[] }[] {
  const byText = new Map<string, { id: string; title: string }[]>();
  for (const p of products) {
    const text = htmlToText(p.descriptionHtml);
    if (text === "") continue;
    const list = byText.get(text) ?? [];
    list.push({ id: p.id, title: p.title });
    byText.set(text, list);
  }
  return [...byText.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([text, list]) => ({ text: text.slice(0, 200), products: list }))
    .sort((a, b) => b.products.length - a.products.length);
}
