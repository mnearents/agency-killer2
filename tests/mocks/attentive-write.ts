import { vi } from "vitest";
import type {
  AttentiveWriteClient,
  BulkJobResult,
  SubscriberEligibility,
} from "@/integrations/attentive-write";

/**
 * Defaults are deliberately inert: no segments, no job outcome, nobody
 * eligible. A mock that defaults to "everything worked" would let a test assert
 * behaviour over a state the real API never hands back for free.
 */
export function createMockAttentiveWriteClient(
  overrides?: Partial<AttentiveWriteClient>
): AttentiveWriteClient {
  return {
    listSegments: vi.fn().mockResolvedValue([]),
    createSegment: vi.fn().mockResolvedValue({ externalId: "seg", name: "seg" }),
    addSegmentMembers: vi.fn().mockResolvedValue({ batchJobId: "job-add" }),
    removeSegmentMembers: vi.fn().mockResolvedValue({ batchJobId: "job-remove" }),
    // Not "COMPLETED with zero failures" — an unfinished job is the honest default.
    getBulkJob: vi.fn().mockResolvedValue(makeBulkJobResult()),
    getEligibility: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

export function makeBulkJobResult(overrides: Partial<BulkJobResult> = {}): BulkJobResult {
  return {
    status: "IN_PROGRESS",
    succeeded: null,
    failed: null,
    failures: [],
    problem: null,
    ...overrides,
  };
}

export function makeEligibility(
  email: string,
  overrides: Partial<SubscriberEligibility> = {}
): SubscriberEligibility {
  return { email, known: true, marketingEligible: true, ...overrides };
}
