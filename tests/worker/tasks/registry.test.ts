import { describe, it, expect } from "vitest";
import { getPhase1Tasks, getTaskHandlerMap } from "@/worker/tasks/registry";
import { createSchedulerState, getDueTasks, getNextRunTime } from "@/worker/scheduler";

describe("getPhase1Tasks: task definitions", () => {
  it("includes Meta ads sync (daily)", () => {
    const tasks = getPhase1Tasks();
    const meta = tasks.find((t) => t.id === "meta-sync");
    expect(meta).toBeDefined();
    expect(meta!.schedule.type).toBe("daily");
    expect(meta!.enabled).toBe(true);
  });

  it("includes Shopify orders sync (daily)", () => {
    const tasks = getPhase1Tasks();
    const shopify = tasks.find((t) => t.id === "shopify-sync");
    expect(shopify).toBeDefined();
    expect(shopify!.schedule.type).toBe("daily");
    expect(shopify!.enabled).toBe(true);
  });

  it("includes KB sync from Dropbox (every 6 hours)", () => {
    const tasks = getPhase1Tasks();
    const kb = tasks.find((t) => t.id === "kb-sync");
    expect(kb).toBeDefined();
    expect(kb!.schedule).toEqual({ type: "interval", hours: 6 });
    expect(kb!.enabled).toBe(true);
  });

  it("includes blog generation (weekly Tuesday 9am)", () => {
    const tasks = getPhase1Tasks();
    const blog = tasks.find((t) => t.id === "blog-generate");
    expect(blog).toBeDefined();
    expect(blog!.schedule).toEqual({ type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 });
    expect(blog!.enabled).toBe(true);
  });

  it("includes ad performance analysis (daily)", () => {
    const tasks = getPhase1Tasks();
    const analysis = tasks.find((t) => t.id === "ads-analysis");
    expect(analysis).toBeDefined();
    expect(analysis!.schedule.type).toBe("daily");
    expect(analysis!.enabled).toBe(true);
  });

  it("has no duplicate IDs", () => {
    const tasks = getPhase1Tasks();
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every task has a non-empty name", () => {
    const tasks = getPhase1Tasks();
    for (const task of tasks) {
      expect(task.name.length).toBeGreaterThan(0);
    }
  });
});

describe("getTaskHandlerMap: handler wiring", () => {
  it("maps every Phase 1 task ID to a handler", () => {
    const tasks = getPhase1Tasks();
    const handlers = getTaskHandlerMap();

    for (const task of tasks) {
      expect(handlers[task.id]).toBeDefined();
      expect(handlers[task.id].length).toBeGreaterThan(0);
    }
  });

  it("has no handlers for non-existent tasks", () => {
    const tasks = getPhase1Tasks();
    const handlers = getTaskHandlerMap();
    const taskIds = new Set(tasks.map((t) => t.id));

    for (const id of Object.keys(handlers)) {
      expect(taskIds.has(id)).toBe(true);
    }
  });
});

describe("Phase 1 tasks integrate with scheduler", () => {
  it("all tasks register in the scheduler without error", () => {
    const tasks = getPhase1Tasks();
    const state = createSchedulerState(tasks);
    expect(state.tasks).toHaveLength(tasks.length);
  });

  it("all tasks compute a valid next run time", () => {
    const tasks = getPhase1Tasks();
    const now = new Date("2025-06-15T10:00:00Z");

    for (const task of tasks) {
      const next = getNextRunTime(task, now);
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("on fresh start, all enabled tasks are due", () => {
    const tasks = getPhase1Tasks();
    const state = createSchedulerState(tasks);
    // At a time well past any scheduled hour, all should be due
    const due = getDueTasks(state, new Date("2025-06-15T23:59:00Z"));
    const enabledCount = tasks.filter((t) => t.enabled).length;
    expect(due.length).toBe(enabledCount);
  });
});
