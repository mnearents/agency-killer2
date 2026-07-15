/**
 * Dropbox API client — the seam.
 * Used for syncing knowledge base documents and video footage.
 *
 * Uses the Dropbox HTTP API with refresh token auth (long-lived).
 */

export interface DropboxFileEntry {
  path: string;
  name: string;
  rev: string;
  size: number;
  isFolder: boolean;
}

export interface DropboxClient {
  listFolder(path: string): Promise<DropboxFileEntry[]>;
  downloadText(path: string): Promise<string>;
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
        allEntries.push({
          path: entry.path_lower ?? entry.path_display,
          name: entry.name,
          rev: entry.rev ?? "",
          size: entry.size ?? 0,
          isFolder: entry[".tag"] === "folder",
        });
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

        data = await contResponse.json();
        for (const entry of data.entries) {
          allEntries.push({
            path: entry.path_lower ?? entry.path_display,
            name: entry.name,
            rev: entry.rev ?? "",
            size: entry.size ?? 0,
            isFolder: entry[".tag"] === "folder",
          });
        }
        hasMore = data.has_more;
        cursor = data.cursor;
      }

      return allEntries;
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
