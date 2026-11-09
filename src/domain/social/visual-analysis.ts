/**
 * What a post SHOWS — the half of a post the transcript cannot see.
 *
 * Claude looks at what Instagram will give: an image, a carousel's slides, a
 * reel's frames (0, 1, 2, 3s, then every 3s) or, when Instagram withholds the
 * video, its cover. What can be known depends on which, so the parser drops
 * anything the input cannot support — a cover says nothing about a reel's
 * first two seconds, however confidently a model describes them.
 *
 * Cuts, length and loudness are measured by ffmpeg (integrations/video-
 * frames.ts), not judged from stills.
 *
 * Pure — no network, no model, no clock.
 */

import { SILENT_DB, type VideoFacts } from "@/integrations/video-frames";

export const VISUAL_TYPES = ["illustration", "photo", "product", "person", "text-graphic", "meme", "mixed", "other"] as const;
export type VisualType = (typeof VISUAL_TYPES)[number];

/** What the analysis looked at. */
export type VisualKind = "frames" | "cover" | "image" | "slides";

export const MAX_VISUAL_ATTEMPTS = 3;

export interface OnScreenText {
  /** "0s", "slide 2", or "cover". */
  at: string;
  text: string;
}

export interface VisualAnalysis {
  summary: string;
  visualType: VisualType;
  /** Hand-drawn illustration — on Tara's posts, her own style. */
  handDrawn: boolean | null;
  onScreenText: OnScreenText[];
  /** The opening frame. Frames only. */
  firstFrame: string | null;
  /** Text on screen in the first three seconds, or on the first slide or image. */
  visualHook: string | null;
  /** Frames only: a cover cannot say. */
  faceInFirst2s: boolean | null;
  productVisible: boolean | null;
  productFirstSeen: string | null;
  setting: string | null;
  /** The feeling or joke it carries. */
  emotion: string | null;
  /** Her handle, logo or brand name visible. */
  branding: boolean | null;
}

const secs = (ms: number) => `${Math.round(ms / 100) / 10}s`;

export function buildVisualPrompt(input: {
  kind: VisualKind;
  account: "own" | "peer";
  caption: string | null;
  frameTimesMs?: number[];
  slideCount?: number;
  transcriptOpening?: string | null;
}): { prompt: string; labels: string[] } {
  const labels =
    input.kind === "frames" ? (input.frameTimesMs ?? [0]).map((t) => `Frame at ${secs(t)}`)
    : input.kind === "slides" ? Array.from({ length: input.slideCount ?? 1 }, (_, i) => `Slide ${i + 1}`)
    : input.kind === "cover" ? ["Cover image"]
    : ["Image"];

  const whose = input.account === "own"
    ? "an Instagram post by Rad & Happy, a small stationery brand whose founder Tara draws its hand-drawn doodle and coloring illustrations. `handDrawn` true means Tara's own illustration style is in it."
    : "an Instagram post by another brand in the same niche. `handDrawn` true means hand-drawn illustration is in it.";

  const what =
    input.kind === "frames" ? "You are shown stills from a reel, each labelled with its time. `firstFrame` describes the frame at 0s; `visualHook` is any text on screen in the first 3 seconds; `faceInFirst2s` is whether a person's face is visible at 0s, 1s or 2s; `productFirstSeen` is the label of the first frame a product appears in."
    : input.kind === "cover" ? "You are shown only the reel's cover image. You cannot see the video, so set `firstFrame`, `visualHook` and `faceInFirst2s` to null and label on-screen text \"cover\"."
    : input.kind === "slides" ? "You are shown a carousel's slides in order. `visualHook` is text on slide 1; `productFirstSeen` is the slide a product first appears on; set `firstFrame` and `faceInFirst2s` to null."
    : "You are shown one image. `visualHook` is text on it; set `firstFrame` and `faceInFirst2s` to null.";

  const prompt = [
    `You are cataloguing what ${whose}`,
    what,
    `Return JSON only with: \`summary\` (one sentence on what it shows); \`visualType\` (one of ${VISUAL_TYPES.join(", ")}); \`handDrawn\` (true/false); ` +
      "`onScreenText` (array of {at, text}: every piece of text in the image or frames, exactly as written, with the label it appears on; leave out text repeated on consecutive frames); " +
      "`firstFrame`; `visualHook`; `faceInFirst2s` (true/false/null); `productVisible` (true/false: is a product the brand sells shown); `productFirstSeen` (a label or null); " +
      "`setting` (where it is, 2-5 words, or null); `emotion` (the feeling or joke it carries, a few words); `branding` (true/false: handle, logo or brand name visible).",
    "Describe only what is visible. Use null where you cannot tell.",
    `Caption:\n"""\n${(input.caption ?? "(none)").slice(0, 2000)}\n"""`,
    ...(input.transcriptOpening ? [`The first words spoken: "${input.transcriptOpening}"`] : []),
  ].join("\n\n");
  return { prompt, labels };
}

/**
 * Reads the answer, failing closed: null for anything that is not a JSON
 * object with something in it. Fields the input cannot support are nulled
 * whatever the model said.
 */
export function parseVisualAnalysis(raw: string, kind: VisualKind): VisualAnalysis | null {
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
  const text = (k: string) => (typeof obj[k] === "string" && (obj[k] as string).trim() !== "" ? (obj[k] as string).trim() : null);
  const bool = (k: string) => (typeof obj[k] === "boolean" ? (obj[k] as boolean) : null);

  const type = text("visualType")?.toLowerCase() ?? null;
  const onScreenText = (Array.isArray(obj.onScreenText) ? obj.onScreenText : [])
    .filter((e): e is { at?: unknown; text?: unknown } => typeof e === "object" && e !== null)
    .filter((e) => typeof e.text === "string" && e.text.trim() !== "")
    .map((e) => ({ at: kind === "cover" ? "cover" : typeof e.at === "string" ? e.at : "", text: (e.text as string).trim() }));

  const analysis: VisualAnalysis = {
    summary: text("summary") ?? "",
    visualType: type === null ? "other" : (VISUAL_TYPES as readonly string[]).includes(type) ? (type as VisualType) : "other",
    handDrawn: bool("handDrawn"),
    onScreenText,
    firstFrame: kind === "frames" ? text("firstFrame") : null,
    visualHook: kind === "cover" ? null : text("visualHook"),
    faceInFirst2s: kind === "frames" ? bool("faceInFirst2s") : null,
    productVisible: bool("productVisible"),
    productFirstSeen: text("productFirstSeen"),
    setting: text("setting"),
    emotion: text("emotion"),
    branding: bool("branding"),
  };
  const empty = analysis.summary === "" && type === null && onScreenText.length === 0 && analysis.handDrawn === null && analysis.productVisible === null;
  return empty ? null : analysis;
}

export type AudioKind = "speech" | "music-or-sound" | "silent" | "licensed-music-likely" | "sound-unclassified" | "unknown";

/**
 * What a reel sounds like, from what is measured. Instagram withholds the
 * video of reels carrying licensed music, so a reel with no video URL most
 * likely used a sound from its library — the nearest thing to "trending
 * audio" the API reveals.
 */
export function classifyAudio(input: {
  videoAvailable: boolean;
  facts: Pick<VideoFacts, "hasAudio" | "meanVolumeDb"> | null;
  transcriptionStatus: string | null;
}): AudioKind {
  if (!input.videoAvailable) return "licensed-music-likely";
  if (!input.facts) return "unknown";
  if (!input.facts.hasAudio || (input.facts.meanVolumeDb !== null && input.facts.meanVolumeDb < SILENT_DB)) return "silent";
  if (input.transcriptionStatus === "ok") return "speech";
  if (input.transcriptionStatus === "no-audio") return "music-or-sound";
  return "sound-unclassified";
}

/** `unavailable` is terminal: there was nothing to look at. */
export function shouldAnalyseVisual(state: { status: string; attempts: number } | null): boolean {
  if (state === null) return true;
  if (state.status !== "error") return false;
  return state.attempts < MAX_VISUAL_ATTEMPTS;
}
