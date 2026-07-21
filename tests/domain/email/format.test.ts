import { describe, it, expect } from "vitest";
import { parseCreativeOutput, formatCreativeForSlack, formatEmailOutput } from "@/domain/email/format";
import type { EmailCreativeSpec } from "@/domain/email/creative";

const VALID_SPEC: EmailCreativeSpec = {
  subjectLine: "Summer planners are here!",
  previewText: "New arrivals you'll love",
  headline: "Plan Your Best Summer Yet",
  bodyCopy: "Our new collection just dropped and it's so good.",
  ctaText: "Shop Now",
  ctaUrl: "https://radandhappy.com/collections/summer",
  altText: "Summer planner collection with rose gold daily planner",
  imageTemplateData: { headline: "Plan Your Best Summer Yet" },
};

describe("parseCreativeOutput", () => {
  it("parses valid JSON", () => {
    const result = parseCreativeOutput(JSON.stringify(VALID_SPEC));
    expect(result).not.toBeNull();
    expect(result!.subjectLine).toBe("Summer planners are here!");
  });

  it("handles JSON wrapped in markdown code blocks", () => {
    const wrapped = "```json\n" + JSON.stringify(VALID_SPEC) + "\n```";
    const result = parseCreativeOutput(wrapped);
    expect(result).not.toBeNull();
    expect(result!.headline).toBe("Plan Your Best Summer Yet");
  });

  it("handles code blocks without json language tag", () => {
    const wrapped = "```\n" + JSON.stringify(VALID_SPEC) + "\n```";
    const result = parseCreativeOutput(wrapped);
    expect(result).not.toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseCreativeOutput("not json at all")).toBeNull();
  });

  it("returns null for JSON missing required fields", () => {
    expect(parseCreativeOutput('{"foo": "bar"}')).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCreativeOutput("")).toBeNull();
  });
});

describe("formatCreativeForSlack", () => {
  it("formats all fields with Slack mrkdwn", () => {
    const text = formatCreativeForSlack(VALID_SPEC, "summer sale promo");
    expect(text).toContain("*Email Creative — summer sale promo*");
    expect(text).toContain("*Subject Line:* Summer planners are here!");
    expect(text).toContain("*Preview Text:* New arrivals you'll love");
    expect(text).toContain("*Headline:* Plan Your Best Summer Yet");
    expect(text).toContain("*Body Copy:*");
    expect(text).toContain("Our new collection just dropped");
    expect(text).toContain("*CTA:* Shop Now");
    expect(text).toContain("radandhappy.com");
    expect(text).toContain("*Alt Text:*");
  });
});

describe("formatEmailOutput", () => {
  it("parses JSON and formats cleanly when valid", () => {
    const text = formatEmailOutput(JSON.stringify(VALID_SPEC), "summer sale");
    expect(text).toContain("*Subject Line:*");
    expect(text).toContain("Summer planners are here!");
    expect(text).not.toContain("{"); // no raw JSON
  });

  it("returns raw text with header when JSON parsing fails", () => {
    const text = formatEmailOutput("Here's a great email idea...", "test");
    expect(text).toContain("*Email Creative — test*");
    expect(text).toContain("Here's a great email idea");
  });
});
