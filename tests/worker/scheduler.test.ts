import { describe, it, expect } from "vitest";
import {
  createSchedulerState,
  getNextRunTime,
  getDueTasks,
  recordTaskRun,
  type TaskDefinition,
  type SchedulerState,
} from "@/worker/scheduler";

const DAILY_TASK: TaskDefinition = {
  id: "meta-sync",
  name: "Meta Ads Sync",
  schedule: { type: "daily", hour: 6, minute: 0 },
  enabled: true,
};

const HOURLY_TASK: TaskDefinition = {
  id: "health-check",
  name: "Health Check",
  schedule: { type: "interval", hours: 1 },
  enabled: true,
};

const WEEKLY_TASK: TaskDefinition = {
  id: "blog-generate",
  name: "Blog Article Generation",
  schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 }, // Tuesday 9am
  enabled: true,
};

const DISABLED_TASK: TaskDefinition = {
  id: "disabled",
  name: "Disabled Task",
  schedule: { type: "daily", hour: 12 },
  enabled: false,
};

// ─── Scheduler state ──────────────────────────────────────────────────

describe("createSchedulerState", () => {
  it("initializes with tasks and empty lastRuns", () => {
    const state = createSchedulerState([DAILY_TASK, HOURLY_TASK]);
    expect(state.tasks).toHaveLength(2);
    expect(state.lastRuns.size).toBe(0);
  });
});

// ─── Next run time computation ────────────────────────────────────────

describe("getNextRunTime: daily tasks", () => {
  it("returns today at scheduled hour if not yet passed", () => {
    // It's 5am, task runs at 6am → next run is today at 6am
    const after = new Date("2025-06-15T05:00:00Z");
    const next = getNextRunTime(DAILY_TASK, after);
    expect(next).toEqual(new Date("2025-06-15T06:00:00Z"));
  });

  it("returns tomorrow at scheduled hour if already passed today", () => {
    // It's 7am, task runs at 6am → next run is tomorrow at 6am
    const after = new Date("2025-06-15T07:00:00Z");
    const next = getNextRunTime(DAILY_TASK, after);
    expect(next).toEqual(new Date("2025-06-16T06:00:00Z"));
  });

  it("returns tomorrow when exactly at scheduled time", () => {
    // It's exactly 6am → already ran, next is tomorrow
    const after = new Date("2025-06-15T06:00:00Z");
    const next = getNextRunTime(DAILY_TASK, after);
    expect(next).toEqual(new Date("2025-06-16T06:00:00Z"));
  });
});

describe("getNextRunTime: interval tasks", () => {
  it("returns after + interval hours", () => {
    const after = new Date("2025-06-15T10:30:00Z");
    const next = getNextRunTime(HOURLY_TASK, after);
    expect(next).toEqual(new Date("2025-06-15T11:30:00Z"));
  });

  it("handles multi-hour intervals", () => {
    const task: TaskDefinition = {
      id: "six-hour",
      name: "Six Hour Task",
      schedule: { type: "interval", hours: 6 },
      enabled: true,
    };
    const after = new Date("2025-06-15T10:00:00Z");
    const next = getNextRunTime(task, after);
    expect(next).toEqual(new Date("2025-06-15T16:00:00Z"));
  });
});

describe("getNextRunTime: weekly tasks", () => {
  it("returns this week if day hasn't passed", () => {
    // Sunday June 15 2025, task runs Tuesday → June 17
    const after = new Date("2025-06-15T08:00:00Z"); // Sunday
    const next = getNextRunTime(WEEKLY_TASK, after);
    expect(next).toEqual(new Date("2025-06-17T09:00:00Z")); // Tuesday
  });

  it("returns next week if day already passed", () => {
    // Wednesday June 18 2025, task runs Tuesday → next Tuesday June 24
    const after = new Date("2025-06-18T10:00:00Z"); // Wednesday
    const next = getNextRunTime(WEEKLY_TASK, after);
    expect(next).toEqual(new Date("2025-06-24T09:00:00Z")); // Next Tuesday
  });

  it("returns next week when on the day but past the hour", () => {
    // Tuesday June 17 at 10am, task runs Tuesday 9am → next Tuesday
    const after = new Date("2025-06-17T10:00:00Z");
    const next = getNextRunTime(WEEKLY_TASK, after);
    expect(next).toEqual(new Date("2025-06-24T09:00:00Z"));
  });
});

// ─── Due task selection ───────────────────────────────────────────────

describe("getDueTasks", () => {
  it("returns tasks that have never run and are past their first scheduled time", () => {
    const state = createSchedulerState([DAILY_TASK]);
    // It's 7am, daily task at 6am has never run → due
    const due = getDueTasks(state, new Date("2025-06-15T07:00:00Z"));
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("meta-sync");
  });

  it("returns tasks whose next run time has passed since last run", () => {
    let state = createSchedulerState([HOURLY_TASK]);
    // Last ran at 10am, now it's 11:30am → 1hr interval passed → due
    state = recordTaskRun(state, "health-check", new Date("2025-06-15T10:00:00Z"));
    const due = getDueTasks(state, new Date("2025-06-15T11:30:00Z"));
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("health-check");
  });

  it("excludes tasks whose next run hasn't arrived", () => {
    let state = createSchedulerState([HOURLY_TASK]);
    // Last ran at 10am, now it's 10:30am → not yet due (next at 11am)
    state = recordTaskRun(state, "health-check", new Date("2025-06-15T10:00:00Z"));
    const due = getDueTasks(state, new Date("2025-06-15T10:30:00Z"));
    expect(due).toHaveLength(0);
  });

  it("excludes disabled tasks", () => {
    const state = createSchedulerState([DISABLED_TASK]);
    const due = getDueTasks(state, new Date("2025-06-15T13:00:00Z"));
    expect(due).toHaveLength(0);
  });

  it("returns multiple due tasks in registration order", () => {
    const state = createSchedulerState([DAILY_TASK, HOURLY_TASK]);
    // Both have never run, both are past their time
    const due = getDueTasks(state, new Date("2025-06-15T07:00:00Z"));
    expect(due).toHaveLength(2);
    expect(due[0].id).toBe("meta-sync");
    expect(due[1].id).toBe("health-check");
  });
});

// ─── Record task run ──────────────────────────────────────────────────

describe("recordTaskRun", () => {
  it("records the run time for a task", () => {
    const state = createSchedulerState([DAILY_TASK]);
    const ranAt = new Date("2025-06-15T06:00:00Z");
    const updated = recordTaskRun(state, "meta-sync", ranAt);
    expect(updated.lastRuns.get("meta-sync")).toEqual(ranAt);
  });

  it("preserves existing task definitions", () => {
    const state = createSchedulerState([DAILY_TASK, HOURLY_TASK]);
    const updated = recordTaskRun(state, "meta-sync", new Date());
    expect(updated.tasks).toHaveLength(2);
  });

  it("overwrites previous run time", () => {
    let state = createSchedulerState([DAILY_TASK]);
    state = recordTaskRun(state, "meta-sync", new Date("2025-06-14T06:00:00Z"));
    state = recordTaskRun(state, "meta-sync", new Date("2025-06-15T06:00:00Z"));
    expect(state.lastRuns.get("meta-sync")).toEqual(new Date("2025-06-15T06:00:00Z"));
  });
});
