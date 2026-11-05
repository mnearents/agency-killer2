/**
 * Google Drive, read-only, through the worker's service account.
 *
 * Used for the invoice folder Matt's email automation fills: the folder is
 * shared with the service account as a Viewer, and nothing else is visible to
 * it. A folder it cannot see answers 404, which is reported as "share it with
 * <service account>", not as an empty folder.
 */

import { createServiceAccountTokenSource, parseServiceAccount } from "./google-auth";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  /** Changes when the file's content changes. Absent on Google Docs. */
  md5Checksum?: string;
  modifiedTime: string;
}

export interface GoogleDriveClient {
  /** Throws, naming the fix, unless the folder is readable. Returns its name. */
  assertFolder(folderId: string): Promise<string>;
  listFolder(folderId: string): Promise<DriveFile[]>;
  download(fileId: string): Promise<Uint8Array>;
}

export interface GoogleDriveConfig {
  credentialsJson: string;
  fetchFn?: typeof fetch;
  signFn?: (unsigned: string, privateKey: string) => string;
  now?: () => number;
}

const API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export function createGoogleDriveClient(config: GoogleDriveConfig): GoogleDriveClient {
  const { client_email } = parseServiceAccount(config.credentialsJson);
  const doFetch = config.fetchFn ?? fetch;
  const token = createServiceAccountTokenSource({ ...config, scope: SCOPE, label: "Google Drive" });

  async function get(path: string, params: Record<string, string> = {}): Promise<Response> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries({ supportsAllDrives: "true", ...params })) url.searchParams.set(k, v);
    const res = await doFetch(url.toString(), { headers: { Authorization: `Bearer ${await token()}` } });
    if (res.ok) return res;
    const body = await res.text();
    if (res.status === 404) {
      throw new Error(`Google Drive cannot see ${path}. Share the folder with ${client_email} as a Viewer.`);
    }
    if (res.status === 403 && /has not been used|is disabled/i.test(body)) {
      throw new Error(`Enable the Google Drive API for the service account's project (Google Cloud console → APIs & Services): ${body.slice(0, 200)}`);
    }
    throw new Error(`Google Drive GET ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }

  return {
    async assertFolder(folderId) {
      const res = await get(`/files/${encodeURIComponent(folderId)}`, { fields: "id,name,mimeType" });
      const f = (await res.json()) as { name: string; mimeType: string };
      if (f.mimeType !== "application/vnd.google-apps.folder") throw new Error(`${folderId} is a ${f.mimeType}, not a folder.`);
      return f.name;
    },

    async listFolder(folderId) {
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const res = await get("/files", {
          q: `'${folderId}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType,md5Checksum,modifiedTime)",
          pageSize: "1000",
          includeItemsFromAllDrives: "true",
          ...(pageToken ? { pageToken } : {}),
        });
        const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
        files.push(...(body.files ?? []));
        pageToken = body.nextPageToken;
      } while (pageToken);
      return files;
    },

    async download(fileId) {
      const res = await get(`/files/${encodeURIComponent(fileId)}`, { alt: "media" });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
