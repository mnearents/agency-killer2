import { vi } from "vitest";
import type { AssemblyAiClient } from "@/integrations/assemblyai";

export function createMockAssemblyAiClient(
  overrides?: Partial<AssemblyAiClient>
): AssemblyAiClient {
  return {
    transcribe: vi.fn().mockResolvedValue({
      id: "mock-transcript-id",
      status: "completed",
      text: "This is a mock transcript.",
    }),
    ...overrides,
  };
}
