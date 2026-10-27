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
      words: [],
      durationMs: null,
    }),
    listCompletedTranscriptIds: vi.fn().mockResolvedValue([]),
    getTranscript: vi.fn().mockRejectedValue(new Error("no transcript")),
    ...overrides,
  };
}
