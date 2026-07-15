import { describe, it, expect, vi } from "vitest";
import {
  dispatchTask,
  dispatchDueTasks,
  type DispatcherConfig,
  type HandlerFn,
} from "@/worker/dispatcher";

function makeConfig(
  handlers: Record<string, HandlerFn> = {}
): DispatcherConfig {
  return {
    handlerMap: {
      "meta-sync": "sync:meta",
      "shopify-sync": "sync:shopify",
      "kb-sync": "sync:knowledge-base",
      "blog-generate": "blog:create",
      "ads-analysis": "meta:analysis",
    },
    handlerFns: {
      "sync:meta": vi.fn().mockResolvedValue(undefined),
      "sync:shopify": vi.fn().mockResolvedValue(undefined),
      "sync:knowledge-base": vi.fn().mockResolvedValue(undefined),
      "blog:create": vi.fn().mockResolvedValue(undefined),
      "meta:analysis": vi.fn().mockResolvedValue(undefined),
      ...handlers,
    },
  };
}

// Deterministic clock — no wall clock
const fakeClock = (() => {
  let time = 1000;
  return () => time++;
})();

// ─── Single task dispatch ─────────────────────────────────────────────

describe("dispatchTask", () => {
  it("calls the correct handler for a known task", async () => {
    const config = makeConfig();
    const result = await dispatchTask("meta-sync", config, fakeClock);

    expect(result.status).toBe("success");
    expect(result.handler).toBe("sync:meta");
    expect(result.taskId).toBe("meta-sync");
    expect(config.handlerFns["sync:meta"]).toHaveBeenCalledOnce();
  });

  it("returns no-handler for unknown task ID", async () => {
    const config = makeConfig();
    const result = await dispatchTask("nonexistent", config, fakeClock);

    expect(result.status).toBe("no-handler");
    expect(result.taskId).toBe("nonexistent");
  });

  it("returns no-handler when handler name exists in map but no function registered", async () => {
    const config: DispatcherConfig = {
      handlerMap: { "meta-sync": "sync:meta" },
      handlerFns: {}, // no functions registered
    };
    const result = await dispatchTask("meta-sync", config, fakeClock);

    expect(result.status).toBe("no-handler");
  });

  it("returns failed with error message when handler throws", async () => {
    const config = makeConfig({
      "sync:meta": vi.fn().mockRejectedValue(new Error("Connection refused")),
    });
    const result = await dispatchTask("meta-sync", config, fakeClock);

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Connection refused");
  });

  it("records duration in milliseconds", async () => {
    let callCount = 0;
    const clock = () => {
      callCount++;
      return callCount === 1 ? 1000 : 1250; // 250ms duration
    };

    const config = makeConfig();
    const result = await dispatchTask("meta-sync", config, clock);

    expect(result.durationMs).toBe(250);
  });

  it("does not call other handlers", async () => {
    const config = makeConfig();
    await dispatchTask("meta-sync", config, fakeClock);

    expect(config.handlerFns["sync:shopify"]).not.toHaveBeenCalled();
    expect(config.handlerFns["blog:create"]).not.toHaveBeenCalled();
  });
});

// ─── Multiple task dispatch ───────────────────────────────────────────

describe("dispatchDueTasks", () => {
  it("dispatches all tasks and returns results for each", async () => {
    const config = makeConfig();
    const results = await dispatchDueTasks(
      ["meta-sync", "shopify-sync"],
      config,
      fakeClock
    );

    expect(results).toHaveLength(2);
    expect(results[0].taskId).toBe("meta-sync");
    expect(results[1].taskId).toBe("shopify-sync");
    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("success");
  });

  it("continues after a handler failure", async () => {
    const config = makeConfig({
      "sync:meta": vi.fn().mockRejectedValue(new Error("API down")),
    });

    const results = await dispatchDueTasks(
      ["meta-sync", "shopify-sync"],
      config,
      fakeClock
    );

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("failed");
    expect(results[1].status).toBe("success");
    // Shopify handler was still called despite Meta failure
    expect(config.handlerFns["sync:shopify"]).toHaveBeenCalledOnce();
  });

  it("returns empty results for empty task list", async () => {
    const config = makeConfig();
    const results = await dispatchDueTasks([], config, fakeClock);
    expect(results).toHaveLength(0);
  });

  it("handles mix of success, failure, and no-handler", async () => {
    const config = makeConfig({
      "sync:shopify": vi.fn().mockRejectedValue(new Error("Timeout")),
    });

    const results = await dispatchDueTasks(
      ["meta-sync", "shopify-sync", "nonexistent"],
      config,
      fakeClock
    );

    expect(results[0].status).toBe("success");
    expect(results[1].status).toBe("failed");
    expect(results[2].status).toBe("no-handler");
  });
});
