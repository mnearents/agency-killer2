import { describe, it, expect, vi } from "vitest";
import { createGoogleDriveClient } from "@/integrations/google-drive";

const CREDS = JSON.stringify({ client_email: "sa@x.iam.gserviceaccount.com", private_key: "k" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function client(responses: Response[]) {
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes("oauth2")) return json({ access_token: "t", expires_in: 3600 });
    return responses.shift()!;
  });
  return { fetchFn, drive: createGoogleDriveClient({ credentialsJson: CREDS, fetchFn: fetchFn as never, signFn: () => "sig" }) };
}

describe("google drive client", () => {
  it("lists every file in a folder across pages", async () => {
    const { drive, fetchFn } = client([
      json({ files: [{ id: "1", name: "a.pdf", mimeType: "application/pdf", md5Checksum: "m1", modifiedTime: "2026-11-01T00:00:00Z" }], nextPageToken: "p2" }),
      json({ files: [{ id: "2", name: "b.pdf", mimeType: "application/pdf", md5Checksum: "m2", modifiedTime: "2026-11-02T00:00:00Z" }] }),
    ]);
    const files = await drive.listFolder("folder1");
    expect(files.map((f) => f.id)).toEqual(["1", "2"]);
    const listUrl = new URL(String(fetchFn.mock.calls.find((c) => String(c[0]).includes("/files?"))![0]));
    expect(listUrl.searchParams.get("q")).toBe("'folder1' in parents and trashed = false");
  });

  // Not shared with the service account looks like a 404, which must name the fix.
  it("says to share the folder with the service account when it cannot see it", async () => {
    const { drive } = client([json({ error: { code: 404, message: "File not found: folder1." } }, 404)]);
    await expect(drive.assertFolder("folder1")).rejects.toThrow(/Share the folder with sa@x\.iam\.gserviceaccount\.com/);
  });

  it("names the API to enable when Drive is switched off for the project", async () => {
    const { drive } = client([json({ error: { code: 403, message: "Google Drive API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } }, 403)]);
    await expect(drive.assertFolder("folder1")).rejects.toThrow(/Enable the Google Drive API/);
  });

  it("downloads a file's bytes", async () => {
    const { drive } = client([new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })]);
    expect(Array.from(await drive.download("1"))).toEqual([37, 80, 68, 70]);
  });
});
