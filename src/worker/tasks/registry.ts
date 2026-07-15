/**
 * Phase 1 task registry — the concrete task definitions that wire the
 * scheduler to actual work.
 *
 * Each task has an ID, name, schedule, and enabled flag. The handler
 * mapping (which function runs for which task) is separate so the
 * registry stays pure data and testable.
 */

import type { TaskDefinition } from "@/worker/scheduler";

export function getPhase1Tasks(): TaskDefinition[] {
  return [
    {
      id: "meta-sync",
      name: "Meta Ads Data Sync",
      schedule: { type: "daily", hour: 6, minute: 0 },
      enabled: true,
    },
    {
      id: "shopify-sync",
      name: "Shopify Orders Sync",
      schedule: { type: "daily", hour: 6, minute: 30 },
      enabled: true,
    },
    {
      id: "kb-sync",
      name: "Knowledge Base Sync",
      schedule: { type: "interval", hours: 6 },
      enabled: true,
    },
    {
      id: "blog-generate",
      name: "Blog Article Generation",
      schedule: { type: "weekly", dayOfWeek: 2, hour: 9, minute: 0 },
      enabled: true,
    },
    {
      id: "ads-analysis",
      name: "Ad Performance Analysis",
      schedule: { type: "daily", hour: 7, minute: 0 },
      enabled: true,
    },
  ];
}

export function getTaskHandlerMap(): Record<string, string> {
  return {
    "meta-sync": "sync:meta",
    "shopify-sync": "sync:shopify",
    "kb-sync": "sync:knowledge-base",
    "blog-generate": "blog:create",
    "ads-analysis": "meta:analysis",
  };
}
