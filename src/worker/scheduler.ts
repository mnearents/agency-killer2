/**
 * Task scheduler — manages registered tasks with cron-like schedules.
 *
 * This module handles the scheduling logic only (which tasks are due,
 * when they run next). The actual cron tick is handled by node-cron
 * in the worker entry point — this module is pure, testable logic.
 *
 * Time is always injected (no Date.now() / no wall clock) for determinism.
 */

export interface TaskDefinition {
  id: string;
  name: string;
  schedule: Schedule;
  enabled: boolean;
}

export type Schedule =
  | { type: "interval"; hours: number }
  | { type: "daily"; hour: number; minute?: number }
  | { type: "weekly"; dayOfWeek: number; hour: number; minute?: number };

export interface TaskRun {
  taskId: string;
  scheduledAt: Date;
  status: "pending" | "running" | "completed" | "failed";
}

export interface SchedulerState {
  tasks: TaskDefinition[];
  lastRuns: Map<string, Date>;
}

export function createSchedulerState(tasks: TaskDefinition[]): SchedulerState {
  return {
    tasks: [...tasks],
    lastRuns: new Map(),
  };
}

export function getNextRunTime(task: TaskDefinition, after: Date): Date {
  const s = task.schedule;

  if (s.type === "interval") {
    return new Date(after.getTime() + s.hours * 60 * 60 * 1000);
  }

  if (s.type === "daily") {
    const candidate = new Date(after);
    candidate.setUTCHours(s.hour, s.minute ?? 0, 0, 0);

    if (candidate.getTime() <= after.getTime()) {
      // Already passed today — next day
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
  }

  if (s.type === "weekly") {
    const candidate = new Date(after);
    const currentDay = candidate.getUTCDay();
    let daysUntil = s.dayOfWeek - currentDay;

    if (daysUntil < 0) {
      daysUntil += 7;
    } else if (daysUntil === 0) {
      // Same day — check if time has passed
      const todayCandidate = new Date(candidate);
      todayCandidate.setUTCHours(s.hour, s.minute ?? 0, 0, 0);
      if (todayCandidate.getTime() > after.getTime()) {
        return todayCandidate;
      }
      daysUntil = 7;
    }

    candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
    candidate.setUTCHours(s.hour, s.minute ?? 0, 0, 0);
    return candidate;
  }

  // Exhaustive check
  const _exhaustive: never = s;
  throw new Error(`Unknown schedule type: ${JSON.stringify(_exhaustive)}`);
}

export function getDueTasks(
  state: SchedulerState,
  now: Date
): TaskDefinition[] {
  return state.tasks.filter((task) => {
    if (!task.enabled) return false;

    const lastRun = state.lastRuns.get(task.id);

    if (!lastRun) {
      // Never run — due if any scheduled time has passed
      // For interval tasks, they're always due on first check
      if (task.schedule.type === "interval") return true;

      // For daily/weekly, check if the scheduled time today (or this week) has passed
      const nextRun = getNextRunTime(task, new Date(0));
      // Find the most recent scheduled time before now
      let candidate = getNextRunTime(task, new Date(now.getTime() - 24 * 60 * 60 * 1000));
      if (task.schedule.type === "weekly") {
        candidate = getNextRunTime(task, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
      }
      return candidate.getTime() <= now.getTime();
    }

    const nextRun = getNextRunTime(task, lastRun);
    return nextRun.getTime() <= now.getTime();
  });
}

export function recordTaskRun(
  state: SchedulerState,
  taskId: string,
  ranAt: Date
): SchedulerState {
  const newLastRuns = new Map(state.lastRuns);
  newLastRuns.set(taskId, ranAt);
  return {
    tasks: state.tasks,
    lastRuns: newLastRuns,
  };
}
