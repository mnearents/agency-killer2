import { describe, it, expect, vi, afterEach } from "vitest";
import { createAssemblyAiClient } from "@/integrations/assemblyai";

describe("uploadFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  // An uploaded reel has no public URL, so AssemblyAI is handed the bytes and
  // answers with a private one that `transcribe` accepts.
  it("posts the bytes and returns AssemblyAI's link to them", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/abc" }), { status: 200 });
    }));
    const link = await createAssemblyAiClient("key").uploadFile(Buffer.from("video"));
    expect(link).toBe("https://cdn.assemblyai.com/upload/abc");
    expect(calls[0].url).toBe("https://api.assemblyai.com/v2/upload");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
  });

  it("throws, naming the status, when the upload is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too big", { status: 413 })));
    await expect(createAssemblyAiClient("key").uploadFile(Buffer.from("v"))).rejects.toThrow(/413/);
  });
});
