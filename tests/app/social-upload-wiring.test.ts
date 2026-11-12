/**
 * The upload routes' call sites. A route that answered without the shared
 * handler would skip its password and size checks; one built without a
 * transcriber would analyse every upload's frames and silently drop its words.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");

describe("upload routes", () => {
  it("checks credentials through the shared handler", () => {
    expect(read("app/api/social/upload/route.ts")).toMatch(/handleUploadCheck\(request, uploadAuth\(\)\)/);
  });

  it("handles the upload through the shared handler with the real analysis", () => {
    const route = read("app/api/social/upload/[id]/route.ts");
    expect(route).toMatch(/handleReelUpload\(request, id, uploadDeps\(\)\)/);
    expect(route).toMatch(/export const runtime = "nodejs"/);
  });

  it("builds the analysis with ffmpeg, Anthropic and the transcriber", () => {
    const wiring = read("src/domain/social/upload-wiring.ts");
    expect(wiring).toMatch(/analyseUploadedReel\(/);
    expect(wiring).toMatch(/video: createFfmpegToolkit\(\)/);
    expect(wiring).toMatch(/transcriber: .*createAssemblyAiClient/);
    expect(wiring).toMatch(/saveBody: \(body, max\) => saveStreamToTemp\(/);
  });

  // Without this the peer section renders nothing and looks like no peers.
  it("lists peer reels on the upload page, ranked against their own usual", () => {
    const page = read("app/social/uploads/page.tsx");
    expect(page).toMatch(/getPeerPosts\(db\(\)/);
    expect(page).toMatch(/peers=\{peerReelsForUpload\(peerPosts, now\)\}/);
  });

  // Where a broken downloader or a spent plan shows first.
  it("shows this month's downloads and each reel's failed downloads", () => {
    const page = read("app/social/uploads/page.tsx");
    expect(page).toMatch(/getDownloadUsage\(db\(\), now\)/);
    expect(page).toMatch(/downloads=\{downloads\}/);
    expect(page).toMatch(/failures=\{failures\}/);
  });

  it("lists teacher reels on the upload page", () => {
    expect(read("app/social/uploads/page.tsx")).toMatch(/teachers=\{teacherReelsForUpload\(peerPosts\)\}/);
  });

  it("uses the cost form's credentials", () => {
    expect(read("src/domain/social/upload-wiring.ts")).toMatch(/user: process\.env\.COST_FORM_USER, password: process\.env\.COST_FORM_PASSWORD/);
  });
});
