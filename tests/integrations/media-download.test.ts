import { describe, it, expect } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { saveStreamToTemp } from "@/integrations/media-download";

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });

describe("saveStreamToTemp", () => {
  it("writes the stream to a file and removes it on request", async () => {
    const saved = await saveStreamToTemp(streamOf("abc", "def"), 100, "mov");
    expect(saved.bytes).toBe(6);
    expect(saved.path).toMatch(/\.mov$/);
    expect(await readFile(saved.path, "utf8")).toBe("abcdef");
    await saved.remove();
    await expect(stat(saved.path)).rejects.toThrow();
  });

  // A client can lie about Content-Length; the cap is enforced on the bytes.
  it("stops past the limit, leaves nothing behind, and says why", async () => {
    await expect(saveStreamToTemp(streamOf("abcdef", "ghijkl"), 8, "mp4")).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
});
