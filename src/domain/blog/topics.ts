/**
 * Blog topic selection — picks the next topic to write about.
 *
 * Priority algorithm (same as previous project):
 * 1. Seasonal topics near their target date (within 14 days ahead,
 *    7 days behind) come first
 * 2. Then by priority number (lower = higher priority)
 * 3. Then by creation date (oldest first)
 */

import type { BlogTopic as BlogTopicRow } from "@/db/schema";
import type { BlogTopic } from "./prompt";

export interface TopicCandidate {
  id: string;
  title: string;
  description?: string;
  targetDate?: Date | null;
  priority: number;
  tags?: string[] | null;
  createdAt: Date;
}

/**
 * Select the next topic from a list of pending candidates.
 * Pure function — no DB access. Takes already-fetched pending topics.
 *
 * @param candidates - Pending topics from the DB
 * @param asOf - Current date (injected for determinism)
 */
export function selectNextTopic(
  candidates: TopicCandidate[],
  asOf: Date
): TopicCandidate | null {
  if (candidates.length === 0) return null;

  const fourteenDaysAhead = new Date(asOf.getTime() + 14 * 24 * 60 * 60 * 1000);
  const sevenDaysBehind = new Date(asOf.getTime() - 7 * 24 * 60 * 60 * 1000);

  return candidates.sort((a, b) => {
    // Seasonal priority: topics near their target date come first
    const aIsSeasonal =
      a.targetDate &&
      a.targetDate <= fourteenDaysAhead &&
      a.targetDate >= sevenDaysBehind;
    const bIsSeasonal =
      b.targetDate &&
      b.targetDate <= fourteenDaysAhead &&
      b.targetDate >= sevenDaysBehind;

    if (aIsSeasonal && !bIsSeasonal) return -1;
    if (!aIsSeasonal && bIsSeasonal) return 1;

    // Then by priority (lower number = higher priority)
    if (a.priority !== b.priority) return a.priority - b.priority;

    // Then by creation date (oldest first)
    return a.createdAt.getTime() - b.createdAt.getTime();
  })[0];
}

/**
 * Convert a DB topic row + selection into the BlogTopic format
 * expected by the prompt builder.
 */
export function toPromptTopic(candidate: TopicCandidate): BlogTopic {
  return {
    title: candidate.title,
    description: candidate.description ?? undefined,
    targetDate: candidate.targetDate?.toISOString().split("T")[0],
    tags: candidate.tags ?? undefined,
  };
}
