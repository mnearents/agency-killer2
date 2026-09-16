import { describe, it, expect, vi } from "vitest";
import { cleanVoiceVerdict, orchestratorOk, orchestratorBlocked } from "../../mocks/orchestrator";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      voice: cleanVoiceVerdict(),
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
      { ok: true, voice: cleanVoiceVerdict(), text: "unused", inputTokens: 0, outputTokens: 0 },
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
        voice: cleanVoiceVerdict(),
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
        voice: null,
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
      voice: cleanVoiceVerdict(),
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
      voice: cleanVoiceVerdict(),
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

/**
 * ─── "Done" over doing nothing (#38) ──────────────────────────────────
 *
 * With no pending topics this returns `ok: true`, and the weekly cron logged
 *
 *     [blog:create] Done: no topic
 *
 * every Tuesday. `blog_topics` is empty and `blog_generations` has zero rows,
 * so that line has described a no-op for the life of the feature — and it is
 * the same line a successful generation prints.
 *
 * `ok` is the wrong signal to carry this: finding nothing to do is not a
 * failure, so `ok: false` would be a lie in the other direction. The result
 * needs a separate field, and the caller needs to be unable to print a status
 * without consulting it.
 */
describe("generateBlogArticle: nothing to do is not the same as done", () => {
  it("reports that it generated nothing when there are no topics", async () => {
    const result = await generateBlogArticle({
      ...makeDeps(orchestratorOk("unused"), []),
      runOrchestrator: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(result.generated).toBe(false);
    expect(result.topicTitle).toBeNull();
  });

  it("reports that it generated something when it did", async () => {
    const result = await generateBlogArticle({
      ...makeDeps(
        orchestratorOk(JSON.stringify({ title: "T", slug: "t", body: "b", metaDescription: "m" })),
        [{ id: "t1", title: "Ten ways to use a planner", status: "pending" }]
      ),
    });
    expect(result.generated).toBe(true);
  });

  // A failure generated nothing either, and must not read as having done so.
  it("reports generated:false when the run failed", async () => {
    const result = await generateBlogArticle({
      ...makeDeps(orchestratorBlocked([{ rule: "banned-word", detail: "x" }]), [
        { id: "t1", title: "Ten ways", status: "pending" },
      ]),
    });
    expect(result.ok).toBe(false);
    expect(result.generated).toBe(false);
  });
});

/**
 * The weekly task has to say which of the three happened, through the right
 * channel. An empty topic queue is not an error — it is a queue nobody filled
 * — but printing "Done" over it is how a feature looks alive for a year while
 * producing nothing.
 */
describe("worker blog task reporting", () => {
  const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

  it("does not print Done without consulting whether anything was generated", () => {
    const handler = worker.match(/"blog:create": async \(\) => \{[\s\S]{0,2500}?\n    \},/);
    expect(handler, "no scheduled blog:create handler found").not.toBeNull();
    expect(handler![0]).toMatch(/result\.generated/);
  });
});
