import { describe, it, expect } from "vitest";
import { selectNextTopic, toPromptTopic, type TopicCandidate } from "@/domain/blog/topics";

const AS_OF = new Date("2025-06-15T12:00:00Z");

function makeTopic(overrides: Partial<TopicCandidate> & { id: string; title: string }): TopicCandidate {
  return {
    priority: 5,
    createdAt: new Date("2025-06-01"),
    ...overrides,
  };
}

describe("selectNextTopic: priority algorithm", () => {
  it("returns null for empty list", () => {
    expect(selectNextTopic([], AS_OF)).toBeNull();
  });

  it("picks seasonal topics first (target date within 14 days ahead)", () => {
    const seasonal = makeTopic({
      id: "seasonal",
      title: "Father's Day Gift Guide",
      targetDate: new Date("2025-06-20"), // 5 days ahead
      priority: 10, // low priority number-wise
    });
    const highPriority = makeTopic({
      id: "high",
      title: "Generic Post",
      priority: 1, // highest priority number
    });

    const result = selectNextTopic([highPriority, seasonal], AS_OF);
    expect(result!.id).toBe("seasonal");
  });

  it("picks seasonal topics that are up to 7 days behind", () => {
    const recent = makeTopic({
      id: "recent",
      title: "Just Passed Holiday",
      targetDate: new Date("2025-06-10"), // 5 days behind
      priority: 10,
    });
    const other = makeTopic({
      id: "other",
      title: "Other",
      priority: 1,
    });

    const result = selectNextTopic([other, recent], AS_OF);
    expect(result!.id).toBe("recent");
  });

  it("does NOT pick topics more than 14 days ahead as seasonal", () => {
    const tooFar = makeTopic({
      id: "far",
      title: "July 4th",
      targetDate: new Date("2025-07-04"), // 19 days ahead
      priority: 10,
    });
    const other = makeTopic({
      id: "other",
      title: "Other",
      priority: 1,
    });

    const result = selectNextTopic([tooFar, other], AS_OF);
    expect(result!.id).toBe("other"); // lower priority number wins
  });

  it("breaks ties by priority number (lower = higher)", () => {
    const low = makeTopic({ id: "low", title: "Low Priority", priority: 8 });
    const high = makeTopic({ id: "high", title: "High Priority", priority: 2 });

    const result = selectNextTopic([low, high], AS_OF);
    expect(result!.id).toBe("high");
  });

  it("breaks priority ties by creation date (oldest first)", () => {
    const old = makeTopic({
      id: "old",
      title: "Old",
      priority: 5,
      createdAt: new Date("2025-05-01"),
    });
    const recent = makeTopic({
      id: "new",
      title: "New",
      priority: 5,
      createdAt: new Date("2025-06-10"),
    });

    const result = selectNextTopic([recent, old], AS_OF);
    expect(result!.id).toBe("old");
  });
});

describe("toPromptTopic: converts to prompt format", () => {
  it("maps all fields", () => {
    const candidate = makeTopic({
      id: "1",
      title: "Test",
      description: "A description",
      targetDate: new Date("2025-07-01"),
      tags: ["planning", "tips"],
    });
    const result = toPromptTopic(candidate);
    expect(result.title).toBe("Test");
    expect(result.description).toBe("A description");
    expect(result.targetDate).toBe("2025-07-01");
    expect(result.tags).toEqual(["planning", "tips"]);
  });

  it("handles null optional fields", () => {
    const candidate = makeTopic({ id: "1", title: "Minimal" });
    const result = toPromptTopic(candidate);
    expect(result.title).toBe("Minimal");
    expect(result.description).toBeUndefined();
    expect(result.targetDate).toBeUndefined();
  });
});
