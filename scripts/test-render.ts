/**
 * Test script for email image rendering.
 * Run: npx tsx scripts/test-render.ts
 */

import { renderEmailImage, closeRenderer } from "@/domain/email/renderer";
import path from "path";

async function main() {
  console.log("Rendering test email image...");

  const result = await renderEmailImage({
    template: "hero-image",
    data: {
      headline: "The Colorful Sale\nis Here!",
      headlineFontSize: "102",
      backgroundColor: "#000000",
      headlineColor: "#ffffff",
      imageUrl: path.resolve("resources/test-image.jpg"),
      imageAlt: "Colorful doodle drawing",
      starBadgeText: "APRIL\n20TH!",
      starImage: path.resolve("resources/star-neon.png"),
      overlayButtonText: "SHOP THE SALE",
      buttonColor: "#F9FF00",
      buttonTextColor: "#000000",
    },
    outputName: "test-hero",
  });

  console.log(`Output: ${result.outputPath} (${result.width}x${result.height})`);

  await closeRenderer();
}

main().catch(console.error);
