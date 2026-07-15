/**
 * Dropbox API client — the seam.
 * Used for syncing knowledge base documents and video footage.
 *
 * Files are identified by path + revision. A changed revision means
 * the file content has changed and needs re-processing.
 */

export interface DropboxFileEntry {
  path: string;
  name: string;
  rev: string; // Dropbox revision hash — changes when content changes
  size: number;
  isFolder: boolean;
}

export interface DropboxClient {
  listFolder(path: string): Promise<DropboxFileEntry[]>;
  downloadText(path: string): Promise<string>;
}

export function createDropboxClient(
  _appKey: string,
  _appSecret: string,
  _refreshToken: string
): DropboxClient {
  throw new Error(
    "Real Dropbox client not yet implemented — use createMockDropboxClient in tests"
  );
}
