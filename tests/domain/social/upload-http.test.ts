import { describe, it, expect, vi } from "vitest";
import { handleUploadCheck, handleReelUpload, MAX_UPLOAD_BYTES, type UploadHttpDeps } from "@/domain/social/upload-http";

const auth = { user: "matt", password: "secret" };
const authed = { authorization: `Basic ${Buffer.from("matt:secret").toString("base64")}` };
const ID = "18112236008622292";

function deps(o: Partial<UploadHttpDeps> = {}): UploadHttpDeps & { removed: string[] } {
  const removed: string[] = [];
  return {
    auth,
    saveBody: vi.fn().mockImplementation(async () => ({ path: "/tmp/up.mov", bytes: 1234, remove: async () => { removed.push("/tmp/up.mov"); } })),
    analyse: vi.fn().mockResolvedValue({ ok: true, summary: "s", visualHook: "h", durationMs: 12_000, cuts: 6, transcribed: false, transcriptError: null, audioNote: "n" }),
    removed,
    ...o,
  };
}

const put = (headers: Record<string, string> = {}, url = `https://dash/api/social/upload/${ID}?song=Espresso`) =>
  new Request(url, { method: "PUT", headers: { "content-type": "video/quicktime", "content-length": "1234", ...authed, ...headers }, body: "video-bytes" });

describe("handleUploadCheck", () => {
  // The page calls this before choosing a file, so the browser asks for the
  // password before half a gigabyte is sent rather than after.
  it("challenges without credentials and passes with them", async () => {
    expect((await handleUploadCheck(new Request("https://dash/api/social/upload"), auth)).status).toBe(401);
    expect((await handleUploadCheck(new Request("https://dash/api/social/upload", { headers: authed }), auth)).status).toBe(200);
  });

  // Fail closed: no password configured is a refusal, never an open door.
  it("refuses everything when no password is configured", async () => {
    expect((await handleUploadCheck(new Request("https://dash/api/social/upload", { headers: authed }), { user: undefined, password: undefined })).status).toBe(503);
  });
});

describe("handleReelUpload", () => {
  it("saves the body, analyses it with the song given, and removes the file", async () => {
    const d = deps();
    const r = await handleReelUpload(put(), ID, d);
    expect(r.status).toBe(200);
    expect(d.analyse).toHaveBeenCalledWith({ postId: ID, filePath: "/tmp/up.mov", songUsed: "Espresso" });
    expect(await r.json()).toMatchObject({ ok: true, visualHook: "h" });
    expect(d.removed).toEqual(["/tmp/up.mov"]);
  });

  it("refuses without the password, before reading the body", async () => {
    const d = deps();
    const r = await handleReelUpload(put({ authorization: "" }), ID, d);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Basic/);
    expect(d.saveBody).not.toHaveBeenCalled();
  });

  it("refuses an ID that is not an Instagram media ID", async () => {
    expect((await handleReelUpload(put(), "../../etc", deps())).status).toBe(404);
  });

  it("refuses a file declared larger than the limit before reading it", async () => {
    const d = deps();
    expect((await handleReelUpload(put({ "content-length": String(MAX_UPLOAD_BYTES + 1) }), ID, d)).status).toBe(413);
    expect(d.saveBody).not.toHaveBeenCalled();
  });

  it("refuses a file that turns out larger than the limit while saving", async () => {
    const d = deps({ saveBody: vi.fn().mockRejectedValue(Object.assign(new Error("too large"), { code: "TOO_LARGE" })) });
    expect((await handleReelUpload(put(), ID, d)).status).toBe(413);
  });

  it("accepts only .mp4 and .mov video", async () => {
    expect((await handleReelUpload(put({ "content-type": "image/png" }), ID, deps())).status).toBe(415);
    expect((await handleReelUpload(put({ "content-type": "video/mp4" }), ID, deps())).status).toBe(200);
  });

  it("keeps a song name short and treats a blank one as none", async () => {
    const d = deps();
    await handleReelUpload(put({}, `https://dash/api/social/upload/${ID}?song=${"x".repeat(500)}`), ID, d);
    expect(vi.mocked(d.analyse).mock.calls[0][0].songUsed).toHaveLength(200);
    const d2 = deps();
    await handleReelUpload(put({}, `https://dash/api/social/upload/${ID}?song=%20%20`), ID, d2);
    expect(vi.mocked(d2.analyse).mock.calls[0][0].songUsed).toBeNull();
  });

  it.each([
    ["not-found", 404],
    ["not-a-reel", 422],
    ["unreadable-video", 422],
    ["analysis-failed", 502],
  ] as const)("answers %s with %i and still removes the file", async (reason, status) => {
    const d = deps({ analyse: vi.fn().mockResolvedValue({ ok: false, reason, detail: "d" }) });
    const r = await handleReelUpload(put(), ID, d);
    expect(r.status).toBe(status);
    expect(await r.json()).toMatchObject({ ok: false, reason });
    expect(d.removed).toEqual(["/tmp/up.mov"]);
  });
});
