/**
 * What a photo shows, as a vision model reads it, for picking pictures for
 * emails and ads.
 *
 * Every field has a fixed vocabulary so photos can be filtered and counted.
 * The parser fails closed: an answer missing its description, or naming a
 * shot type, background or position outside the vocabulary, is no answer and
 * is retried. Products are held to the Shopify titles the model was given —
 * a title it was not given is a guess, and a guess is recorded as "unknown",
 * never as a product.
 *
 * Pure — no network, no model, no clock.
 */

/** Recorded with every description. The model the app's other vision work uses. */
export const PHOTO_VISION_MODEL = "claude-sonnet-4-6";
/** Dollars per million tokens for PHOTO_VISION_MODEL, to report what a run cost. */
export const PHOTO_VISION_PRICE = { input: 3, output: 15 } as const;
/** The longest side of the copy the model is shown. */
export const VISION_MAX_DIMENSION = 1024;
export const VISION_MAX_TOKENS = 700;

export const SHOT_TYPES = ["flat lay", "in hand", "close-up detail", "cover", "inside pages", "lifestyle scene", "person", "packaging", "other"] as const;
export const PEOPLE = ["none", "hands only", "adult", "child"] as const;
export const BACKGROUNDS = ["light", "dark", "warm neutral", "colored", "busy"] as const;
export const SUBJECT_POSITIONS = ["centered", "left", "right", "top", "bottom"] as const;
export const HEADLINE_SIDES = ["left", "right", "top", "bottom"] as const;
export const QUALITY_FLAGS = ["sharp", "soft", "motion blur", "shallow focus", "overexposed", "underexposed"] as const;
export const SUGGESTED_USES = ["email hero", "email product row", "ad static", "background"] as const;

/** Stored as the whole product list when the model cannot tell which product it is. */
export const UNKNOWN_PRODUCT = "unknown";

export interface PhotoDescription {
  description: string;
  /** Shopify titles; [] when no product is in the picture; ["unknown"] when one is and which is unclear. */
  products: string[];
  shotType: string;
  people: string[];
  background: string;
  visibleText: string | null;
  subjectPosition: string;
  /** The side with clear room for a headline, or null for none. */
  headlineSpace: string | null;
  qualityFlags: string[];
  suggestedUses: string[];
}

const list = (values: readonly string[]) => values.map((v) => `"${v}"`).join(", ");

export function buildPhotoPrompt(input: { folder: string; name: string; productTitles: string[] }): string {
  return [
    "You are cataloguing a photo for Rad & Happy, a small stationery brand (planners, calendars, coloring and doodle books, subscriptions), so the right picture can be picked for an email or an ad.",
    `It is filed in Dropbox as "${input.folder}/${input.name}". The folder can hint at what was being photographed, but describe only what you can see.`,
    "Return JSON only, with exactly these fields:",
    [
      "- `description`: one plain sentence saying what is in the picture.",
      `- \`products\`: which of the brand's products are visible, each exactly as titled in the list below. [] if no product is in the picture. ["${UNKNOWN_PRODUCT}"] if a product is visible but you cannot tell which title it is. Never guess: name a title only when what you see makes it clear.`,
      `- \`shotType\`: one of ${list(SHOT_TYPES)}.`,
      `- \`people\`: a list from ${list(PEOPLE)} — every kind present, or ["none"]. Do not try to identify anyone.`,
      `- \`background\`: one of ${list(BACKGROUNDS)}.`,
      "- `visibleText`: text that can be read in the photo, exactly as written, or null.",
      `- \`subjectPosition\`: where the main subject sits, one of ${list(SUBJECT_POSITIONS)}.`,
      `- \`headlineSpace\`: the side with clear empty space for a headline, one of ${list(HEADLINE_SIDES)}, or null if there is none.`,
      `- \`qualityFlags\`: every one that applies from ${list(QUALITY_FLAGS)}.`,
      `- \`suggestedUses\`: every one it would suit from ${list(SUGGESTED_USES)}; [] if none.`,
    ].join("\n"),
    `Product titles:\n${input.productTitles.map((t) => `- ${t}`).join("\n") || "(none)"}`,
  ].join("\n\n");
}

const oneOf = (values: readonly string[], raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return values.find((x) => x === v) ?? null;
};

const someOf = (values: readonly string[], raw: unknown): string[] =>
  Array.isArray(raw) ? [...new Set(raw.map((r) => oneOf(values, r)).filter((v): v is string => v !== null))] : [];

/**
 * The products named, held to the titles given. Anything that is not one of
 * them makes the whole list unknown: the model was unsure, and part of a
 * guess is still a guess.
 */
export function matchProducts(raw: unknown, productTitles: string[]): string[] {
  if (!Array.isArray(raw)) return [UNKNOWN_PRODUCT];
  const byLower = new Map(productTitles.map((t) => [t.trim().toLowerCase(), t]));
  const matched: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return [UNKNOWN_PRODUCT];
    const title = byLower.get(item.trim().toLowerCase());
    if (!title) return [UNKNOWN_PRODUCT];
    if (!matched.includes(title)) matched.push(title);
  }
  return matched;
}

/** The answer, or null when it cannot be trusted as one. */
export function parsePhotoDescription(raw: string, productTitles: string[]): PhotoDescription | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const shotType = oneOf(SHOT_TYPES, obj.shotType);
  const background = oneOf(BACKGROUNDS, obj.background);
  const subjectPosition = oneOf(SUBJECT_POSITIONS, obj.subjectPosition);
  if (!description || !shotType || !background || !subjectPosition) return null;

  let people = someOf(PEOPLE, obj.people);
  if (people.length === 0) return null;
  // "none" beside someone is a contradiction; the someone is what was seen.
  if (people.length > 1) people = people.filter((p) => p !== "none");

  const headlineSpace = obj.headlineSpace === null ? null : oneOf(HEADLINE_SIDES, obj.headlineSpace);
  if (obj.headlineSpace !== null && headlineSpace === null) return null;

  const visibleText = typeof obj.visibleText === "string" && obj.visibleText.trim() !== "" ? obj.visibleText.trim() : null;

  return {
    description,
    products: matchProducts(obj.products, productTitles),
    shotType,
    people,
    background,
    visibleText,
    subjectPosition,
    headlineSpace,
    qualityFlags: someOf(QUALITY_FLAGS, obj.qualityFlags),
    suggestedUses: someOf(SUGGESTED_USES, obj.suggestedUses),
  };
}

/** Dollars, at PHOTO_VISION_PRICE. */
export function visionCost(inputTokens: number, outputTokens: number): number {
  return Math.round(((inputTokens * PHOTO_VISION_PRICE.input + outputTokens * PHOTO_VISION_PRICE.output) / 1_000_000) * 100) / 100;
}
