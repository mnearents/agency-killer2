/**
 * Phase 1 task registry — the concrete task definitions that wire the
 * scheduler to actual work.
 *
 * Each task has an ID, name, schedule, and enabled flag. The handler
 * mapping (which function runs for which task) is separate so the
 * registry stays pure data and testable.
 */

import type { TaskDefinition } from "@/worker/scheduler";

/**
 * All schedule times are in UTC. Matt is in Pacific (UTC-7).
 *
 *   13:00 UTC (6 AM PT) — Meta ads sync
 *   13:15 UTC           — Shopify sync
 *   13:30 UTC           — Instagram sync
 *   14:00 UTC (7 AM PT) — Ads analysis (after syncs finish)
 *   16:00 UTC (9 AM PT, Tue) — Blog generation
 */
export function getPhase1Tasks(): TaskDefinition[] {
  return [
    {
      id: "meta-sync",
      name: "Meta Ads Data Sync",
      schedule: { type: "daily", hour: 13, minute: 0 },
      enabled: true,
    },
    {
      id: "shopify-sync",
      name: "Shopify Orders Sync",
      schedule: { type: "daily", hour: 13, minute: 15 },
      enabled: true,
    },
    {
      id: "social-sync",
      name: "Instagram Social Sync",
      schedule: { type: "daily", hour: 13, minute: 30 },
      enabled: true,
    },
    {
      id: "attentive-sync",
      name: "Attentive Email/SMS Sync",
      schedule: { type: "daily", hour: 15, minute: 0, skipDays: [0] }, // 8:00 AM PT, skip Sunday
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
      schedule: { type: "weekly", dayOfWeek: 2, hour: 16, minute: 0 },
      enabled: true,
    },
    {
      id: "ads-analysis",
      name: "Ad Performance Analysis",
      schedule: { type: "daily", hour: 14, minute: 0 },
      enabled: true,
    },
    {
      id: "daily-alerts",
      name: "Proactive Alert Check",
      schedule: { type: "daily", hour: 14, minute: 15 }, // 7:15 AM PT, after syncs + analysis
      enabled: true,
    },
    {
      id: "weekly-report",
      name: "Monday Morning Report",
      schedule: { type: "weekly", dayOfWeek: 1, hour: 14, minute: 30 }, // Monday 7:30 AM PT
      enabled: true,
    },
  ];
}

export function getTaskHandlerMap(): Record<string, string> {
  return {
    "meta-sync": "sync:meta",
    "shopify-sync": "sync:shopify",
    "social-sync": "sync:social",
    "attentive-sync": "sync:attentive",
    "kb-sync": "sync:knowledge-base",
    "blog-generate": "blog:create",
    "ads-analysis": "meta:analysis",
    "daily-alerts": "alerts:check",
    "weekly-report": "report:weekly",
  };
}
