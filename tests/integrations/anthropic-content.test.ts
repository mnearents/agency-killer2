import { describe, it, expect } from "vitest";
import { buildUserContent } from "@/integrations/anthropic";

describe("buildUserContent", () => {
  it("is the prompt alone when there are no images", () => {
    expect(buildUserContent("hello")).toBe("hello");
  });

  // The label sits immediately before its image, so "Frame at 3s" cannot be
  // read as describing the frame after it.
  it("puts each image after its label and the prompt last", () => {
    const content = buildUserContent("Describe them.", [
      { label: "Frame at 0s", mediaType: "image/jpeg", data: Buffer.from("a") },
      { mediaType: "image/png", data: Buffer.from("b") },
    ]);
    expect(content).toEqual([
      { type: "text", text: "Frame at 0s" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from("a").toString("base64") } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("b").toString("base64") } },
      { type: "text", text: "Describe them." },
    ]);
  });
});
