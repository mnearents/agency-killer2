import { vi } from "vitest";
import type { DropboxClient } from "@/integrations/dropbox";

export function createMockDropboxClient(
  overrides?: Partial<DropboxClient>
): DropboxClient {
  return {
    listFolder: vi.fn().mockResolvedValue([]),
    downloadText: vi.fn().mockResolvedValue(""),
    ...overrides,
  };
}
