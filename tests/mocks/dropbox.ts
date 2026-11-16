import { vi } from "vitest";
import type { DropboxClient } from "@/integrations/dropbox";

export function createMockDropboxClient(
  overrides?: Partial<DropboxClient>
): DropboxClient {
  return {
    listFolder: vi.fn().mockResolvedValue([]),
    downloadText: vi.fn().mockResolvedValue(""),
    downloadFile: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    getTemporaryLink: vi.fn().mockResolvedValue("https://dl.dropboxusercontent.com/test.mp4"),
    ...overrides,
  };
}
