/**
 * Finished ads — the edited videos exported to `/RAD/Footage/Finished Ads`.
 *
 * They are synced with the rest of the footage (same IDs, moves, transcripts
 * and timings) but are a different thing: raw footage is material to cut, a
 * finished ad is something that has already run or will. An agent that cannot
 * tell them apart counts a used hook as an available one, or plans a cut list
 * from an ad that is already cut. So the kind is decided here, from the folder,
 * and kept apart everywhere downstream — its own knowledge base category, its
 * own analysis, its own tool.
 *
 * Pure — no Dropbox, no database, no model.
 */

export type FootageKind = "raw" | "finished-ad";

/** The folder, directly under the footage root, that holds finished ads. */
export const FINISHED_ADS_FOLDER = "finished ads";

/**
 * Which kind a clip is, from where it sits.
 *
 * Only `Finished Ads` directly under the root counts, and only as a whole
 * folder name: `Finished Ads old/` or a file called `finished ads.mp4` is raw
 * footage. Dropbox paths are case-insensitive, so the comparison is too.
 */
export function footageKind(path: string, rootPath: string): FootageKind {
  const root = rootPath.toLowerCase().replace(/\/+$/, "");
  return path.toLowerCase().startsWith(`${root}/${FINISHED_ADS_FOLDER}/`) ? "finished-ad" : "raw";
}

/** Every knowledge base category a footage document can be filed under. */
export const FOOTAGE_CATEGORIES = ["footage", "finished-ad"] as const;

export function footageCategory(kind: FootageKind): (typeof FOOTAGE_CATEGORIES)[number] {
  return kind === "finished-ad" ? "finished-ad" : "footage";
}

/** The first line of a document, which names its kind and where the clip is. */
export function documentHeader(kind: FootageKind, path: string): string {
  return kind === "finished-ad" ? `[Finished ad ${path}]` : `[Footage ${path}]`;
}

/** A document's title and context prefix, which say what kind of clip it is. */
export function documentLabels(kind: FootageKind, name: string): { title: string; contextPrefix: string } {
  return kind === "finished-ad"
    ? { title: `Finished ad: ${name}`, contextPrefix: `Finished ad ${name}` }
    : { title: `Footage: ${name}`, contextPrefix: `Raw footage file ${name}` };
}

export const AD_ANALYSIS_INSTRUCTION =
  "You are cataloguing a finished video ad for a stationery brand, so a marketer can see which " +
  "hooks and angles have already been used before planning new ads. From the transcript, return " +
  "JSON with these fields: `summary`, one sentence on what the ad says; `tags`, 3-8 short " +
  "lowercase keywords; `hook`, the opening line that is meant to stop the scroll, quoted from the " +
  "transcript; `angle`, the persuasive angle in 2-4 words (for example: time saving, gift idea, " +
  "teacher life, before and after, social proof); `product`, the product advertised as named; " +
  "`callToAction`, what the viewer is told to do, quoted or closely paraphrased; and `format`, " +
  "one or two words (for example: testimonial, tutorial, unboxing, voiceover, talking head). " +
  "Use only what the transcript supports and use null for anything it does not. You cannot see " +
  "the video: a hook or offer that appears only as on-screen text is invisible to you, so do not " +
  "guess at one.";

export interface AdAnalysis {
  summary: string;
  tags: string[];
  /** Null when the transcript has no clear opening line — or it was only on screen. */
  hook: string | null;
  angle: string | null;
  product: string | null;
  callToAction: string | null;
  format: string | null;
}

/**
 * Parses the ad analysis.
 *
 * A field the model did not give is null, never blank, so "unknown" and
 * "empty" stay distinguishable. Returns null for a response with nothing in it
 * — the same rule as `parseTags`, for the same reason: an ad left unanalysed
 * by a bad response must not look like one analysed and found empty.
 */
export function parseAdAnalysis(raw: string): AdAnalysis | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const text = (key: string) => {
    const value = obj[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const lower = (key: string) => text(key)?.toLowerCase() ?? null;
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== "")
    : [];

  const analysis: AdAnalysis = {
    summary: text("summary") ?? "",
    tags: [...new Set(tags)],
    hook: text("hook"),
    angle: lower("angle"),
    product: text("product"),
    callToAction: text("callToAction"),
    format: lower("format"),
  };
  const empty = analysis.summary === "" && analysis.tags.length === 0 &&
    [analysis.hook, analysis.angle, analysis.product, analysis.callToAction, analysis.format].every((v) => v === null);
  return empty ? null : analysis;
}

/**
 * The knowledge base document for a finished ad.
 *
 * The hook and angle sit in the embedded text so a search for an angle finds
 * the ads that used it. The transcript follows the same `Transcript:` marker
 * footage documents use, so `footageTranscript` reads both.
 */
export function finishedAdDocument(input: {
  name: string;
  path: string;
  analysis: AdAnalysis | null;
  transcript: string;
}): { title: string; content: string; contextPrefix: string } {
  const a = input.analysis;
  const lines = [
    a?.summary ? `Summary: ${a.summary}` : null,
    a?.hook ? `Hook: ${a.hook}` : null,
    a?.angle ? `Angle: ${a.angle}` : null,
    a?.product ? `Product: ${a.product}` : null,
    a?.callToAction ? `Call to action: ${a.callToAction}` : null,
    a?.format ? `Format: ${a.format}` : null,
    a && a.tags.length > 0 ? `Tags: ${a.tags.join(", ")}` : null,
  ].filter((l): l is string => l !== null);
  const details = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return {
    ...documentLabels("finished-ad", input.name),
    content: `${documentHeader("finished-ad", input.path)}\n${details}\nTranscript:\n${input.transcript}`,
  };
}
