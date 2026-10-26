/**
 * Dropbox API client — the seam.
 *
 * Reads knowledge base markdown and issues temporary links for footage, which
 * a transcriber fetches directly. Nothing downloads video through here.
 *
 * Uses the Dropbox HTTP API with refresh token auth (long-lived).
 */

export interface DropboxFileEntry {
  /**
   * Dropbox's file ID (`id:...`). Unlike the path it survives a move or a
   * rename, so it is what identifies a file across syncs.
   */
  id: string;
  path: string;
  name: string;
  rev: string;
  /** Dropbox's hash of the bytes. Null for folders. Unchanged by a move. */
  contentHash: string | null;
  size: number;
  isFolder: boolean;
}

/** The fields of a Dropbox `list_folder` entry this client reads. */
interface RawDropboxEntry {
  ".tag": string;
  id: string;
  name: string;
  path_lower?: string;
  path_display: string;
  rev?: string;
  content_hash?: string;
  size?: number;
}

function toEntry(entry: RawDropboxEntry): DropboxFileEntry {
  return {
    id: entry.id,
    path: entry.path_lower ?? entry.path_display,
    name: entry.name,
    rev: entry.rev ?? "",
    contentHash: entry.content_hash ?? null,
    size: entry.size ?? 0,
    isFolder: entry[".tag"] === "folder",
  };
}

export interface DropboxClient {
  listFolder(path: string): Promise<DropboxFileEntry[]>;
  downloadText(path: string): Promise<string>;
  /**
   * A direct, time-limited URL for a file.
   *
   * Video is never downloaded through this process — a transcriber is handed
   * the link and fetches it itself, which keeps a 2GB camera file out of the
   * worker's memory entirely. Dropbox expires these after about four hours,
   * so the link is fetched per attempt and never stored.
   */
  getTemporaryLink(path: string): Promise<string>;
}

interface DropboxTokenState {
  accessToken: string;
  expiresAt: number;
}

async function refreshAccessToken(
  appKey: string,
  appSecret: string,
  refreshToken: string
): Promise<DropboxTokenState> {
  const response = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: appKey,
      client_secret: appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dropbox token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000, // refresh 5 min early
  };
}

export function createDropboxClient(
  appKey: string,
  appSecret: string,
  refreshToken: string
): DropboxClient {
  let tokenState: DropboxTokenState | null = null;

  async function getAccessToken(): Promise<string> {
    if (!tokenState || Date.now() >= tokenState.expiresAt) {
      tokenState = await refreshAccessToken(appKey, appSecret, refreshToken);
    }
    return tokenState.accessToken;
  }

  return {
    async listFolder(path) {
      const token = await getAccessToken();
      const allEntries: DropboxFileEntry[] = [];
      let cursor: string | null = null;
      let hasMore = true;

      // Initial request
      const initialResponse = await fetch(
        "https://api.dropboxapi.com/2/files/list_folder",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path, recursive: true }),
        }
      );

      if (!initialResponse.ok) {
        throw new Error(`Dropbox list_folder failed: ${initialResponse.status}`);
      }

      let data = await initialResponse.json();
      for (const entry of data.entries) {
        allEntries.push(toEntry(entry));
      }
      hasMore = data.has_more;
      cursor = data.cursor;

      // Continue pagination
      while (hasMore && cursor) {
        const contResponse = await fetch(
          "https://api.dropboxapi.com/2/files/list_folder/continue",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ cursor }),
          }
        );

        // A page that fails must fail the whole listing. Callers delete what a
        // listing does not contain, so a partial one would read as deletions.
        if (!contResponse.ok) {
          throw new Error(`Dropbox list_folder/continue failed: ${contResponse.status}`);
        }

        data = await contResponse.json();
        for (const entry of data.entries) {
          allEntries.push(toEntry(entry));
        }
        hasMore = data.has_more;
        cursor = data.cursor;
      }

      return allEntries;
    },

    async getTemporaryLink(path) {
      const token = await getAccessToken();
      const response = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      });

      if (!response.ok) {
        throw new Error(`Dropbox temporary link failed for ${path}: ${response.status}`);
      }

      const data = await response.json();
      if (typeof data.link !== "string" || data.link === "") {
        throw new Error(`Dropbox returned no link for ${path}`);
      }
      return data.link;
    },

    async downloadText(path) {
      const token = await getAccessToken();
      const response = await fetch(
        "https://content.dropboxapi.com/2/files/download",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Dropbox-API-Arg": JSON.stringify({ path }),
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Dropbox download failed: ${response.status}`);
      }

      return response.text();
    },
  };
}
