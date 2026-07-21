/**
 * Email creative output formatting — parses the JSON from the
 * orchestrator and formats it for Slack display.
 */

import type { EmailCreativeSpec } from "./creative";

/**
 * Try to parse orchestrator output as EmailCreativeSpec JSON.
 * Returns null if parsing fails.
 */
export function parseCreativeOutput(text: string): EmailCreativeSpec | null {
  try {
    // The model might wrap JSON in markdown code blocks
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (!parsed.subjectLine || !parsed.headline || !parsed.bodyCopy) {
      return null;
    }

    return parsed as EmailCreativeSpec;
  } catch {
    return null;
  }
}

/**
 * Format parsed email creative for Slack display.
 * Uses Slack's mrkdwn formatting for readability.
 */
export function formatCreativeForSlack(
  spec: EmailCreativeSpec,
  brief: string
): string {
  const lines = [
    `*Email Creative — ${brief}*`,
    "",
    `*Subject Line:* ${spec.subjectLine}`,
    `*Preview Text:* ${spec.previewText}`,
    "",
    `*Headline:* ${spec.headline}`,
    "",
    `*Body Copy:*`,
    spec.bodyCopy,
    "",
    `*CTA:* ${spec.ctaText}${spec.ctaUrl ? ` → ${spec.ctaUrl}` : ""}`,
    "",
    `*Alt Text:* ${spec.altText}`,
  ];

  return lines.join("\n");
}

/**
 * Format the raw orchestrator output — parse as JSON if possible,
 * otherwise return as-is with a note.
 */
export function formatEmailOutput(text: string, brief: string): string {
  const parsed = parseCreativeOutput(text);

  if (parsed) {
    return formatCreativeForSlack(parsed, brief);
  }

  // Model didn't return valid JSON — show raw output with context
  return `*Email Creative — ${brief}*\n\n${text}`;
}
