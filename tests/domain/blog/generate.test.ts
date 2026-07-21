import { describe, it, expect, vi } from "vitest";
import { generateBlogArticle, type BlogGenerateDeps } from "@/domain/blog/generate";
import type { OrchestratorResult } from "@/ai/orchestrator";

function createMockDb(pendingTopics: Array<Record<string, unknown>> = []) {
  const updateCalls: unknown[] = [];
  const insertCalls: unknown[] = [];

  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(pendingTopics),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          updateCalls.push("update");
          return Promise.resolve();
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    _updateCalls: updateCalls,
    _insertCalls: insertCalls,
  } as unknown as BlogGenerateDeps["db"];
}

function makeDeps(
  orchestratorResponse: OrchestratorResult,
  pendingTopics: Array<Record<string, unknown>> = []
): BlogGenerateDeps {
  return {
    db: createMockDb(pendingTopics),
    runOrchestrator: vi.fn().mockResolvedValue(orchestratorResponse),
    getBrandContext: vi.fn().mockResolvedValue("Brand context here."),
    voiceBannedWords: ["shenanigans"],
  };
}

describe("generateBlogArticle", () => {
  it("generates article from override title (doesn't query DB)", async () => {
    const deps = makeDeps({
      ok: true,
      text: "<h2>Great Article</h2><p>Content here.</p>",
      inputTokens: 1000,
      outputTokens: 500,
    });

    const result = await generateBlogArticle(deps, "Best Pens for Journaling");

    expect(result.ok).toBe(true);
    expect(result.topicTitle).toBe("Best Pens for Journaling");
    expect(result.text).toContain("Great Article");

    // Should call orchestrator
    expect(deps.runOrchestrator).toHaveBeenCalled();
    // Should NOT query DB for topics
    expect(deps.db.select).not.toHaveBeenCalled();
  });

  it("returns no-topics message when DB has no pending topics", async () => {
    const deps = makeDeps(
      { ok: true, text: "unused", inputTokens: 0, outputTokens: 0 },
      [] // no pending topics
    );

    const result = await generateBlogArticle(deps);

    expect(result.ok).toBe(true);
    expect(result.text).toContain("No pending");
    expect(result.topicTitle).toBeNull();
    // Should NOT call orchestrator
    expect(deps.runOrchestrator).not.toHaveBeenCalled();
  });

  it("selects topic from DB when no override provided", async () => {
    const deps = makeDeps(
      {
        ok: true,
        text: "<h2>Article</h2>",
        inputTokens: 500,
        outputTokens: 200,
      },
      [
        {
          id: "topic_1",
          title: "Planner Organization Tips",
          description: "SEO article",
          priority: 3,
          status: "pending",
          tags: ["planning"],
          targetDate: null,
          createdAt: new Date("2025-06-01"),
        },
      ]
    );

    const result = await generateBlogArticle(deps);

    expect(result.ok).toBe(true);
    expect(result.topicTitle).toBe("Planner Organization Tips");
  });

  it("returns error when orchestrator blocks output", async () => {
    const deps = makeDeps(
      {
        ok: false,
        guardrailResult: {
          passed: false,
          violations: [
            { rule: "banned-word", detail: 'Output contains "delve"' },
          ],
        },
      },
      [
        {
          id: "topic_1",
          title: "Test",
          priority: 5,
          status: "pending",
          createdAt: new Date(),
        },
      ]
    );

    const result = await generateBlogArticle(deps);

    expect(result.ok).toBe(false);
    expect(result.text).toContain("blocked");
    expect(result.text).toContain("delve");
  });

  it("includes brand context in the prompt", async () => {
    const deps = makeDeps({
      ok: true,
      text: "<h2>Article</h2>",
      inputTokens: 500,
      outputTokens: 200,
    });

    await generateBlogArticle(deps, "Test Topic");

    expect(deps.getBrandContext).toHaveBeenCalled();
    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.prompt).toContain("Brand context here.");
  });

  it("uses neutral blog tone, not Tara's voice", async () => {
    const deps = makeDeps({
      ok: true,
      text: "<h2>Article</h2>",
      inputTokens: 500,
      outputTokens: 200,
    });

    await generateBlogArticle(deps, "Test Topic");

    const call = (deps.runOrchestrator as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.system).toContain("friendly");
    expect(call.system).not.toContain("Study the following writing examples");
  });
});
