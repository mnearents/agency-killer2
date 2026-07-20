/**
 * Blog generation pipeline — selects topic, fetches brand context,
 * generates article through orchestrator with AI-writing avoidance,
 * and records the generation.
 */

import type { Db } from "@/db/client";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import { eq } from "drizzle-orm";
import { blogTopics, blogGenerations } from "@/db/schema";
import { selectNextTopic, toPromptTopic, type TopicCandidate } from "./topics";
import { buildBlogRequest } from "./prompt";

export interface BlogGenerateDeps {
  db: Db;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  getBrandContext: () => Promise<string>;
  voiceBannedWords?: string[];
}

export interface BlogGenerateResult {
  ok: boolean;
  text: string;
  topicTitle: string | null;
}

/**
 * Generate a blog article — either from the next pending topic or
 * an override title from Slack.
 */
export async function generateBlogArticle(
  deps: BlogGenerateDeps,
  overrideTitle?: string
): Promise<BlogGenerateResult> {
  let topic: TopicCandidate | null = null;

  if (overrideTitle) {
    // Create an ad-hoc topic from the Slack command
    topic = {
      id: "adhoc",
      title: overrideTitle,
      priority: 0,
      createdAt: new Date(),
    };
  } else {
    // Fetch pending topics from DB
    try {
      const pending = await deps.db
        .select()
        .from(blogTopics)
        .where(eq(blogTopics.status, "pending"));

      const candidates: TopicCandidate[] = pending.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description ?? undefined,
        targetDate: t.targetDate,
        priority: t.priority,
        tags: t.tags,
        createdAt: t.createdAt,
      }));

      topic = selectNextTopic(candidates, new Date());
    } catch {
      return {
        ok: false,
        text: "Failed to fetch blog topics from the database.",
        topicTitle: null,
      };
    }
  }

  if (!topic) {
    return {
      ok: true,
      text: "No pending blog topics. Add one with `!blog create <topic>`.",
      topicTitle: null,
    };
  }

  // Mark as generating (skip for ad-hoc topics)
  if (topic.id !== "adhoc") {
    try {
      await deps.db
        .update(blogTopics)
        .set({ status: "generating", updatedAt: new Date() })
        .where(eq(blogTopics.id, topic.id));
    } catch {
      // Non-fatal — continue with generation
    }
  }

  // Get brand context
  const brandContext = await deps.getBrandContext();

  // Build the blog request
  const promptTopic = toPromptTopic(topic);
  const request = buildBlogRequest({
    topic: promptTopic,
    brandContext,
    voiceBannedWords: deps.voiceBannedWords,
  });

  // Generate through orchestrator
  const result = await deps.runOrchestrator(request);

  if (!result.ok) {
    // Mark as pending again on failure
    if (topic.id !== "adhoc") {
      try {
        await deps.db
          .update(blogTopics)
          .set({ status: "pending", updatedAt: new Date() })
          .where(eq(blogTopics.id, topic.id));
      } catch {
        // Non-fatal
      }
    }

    const violations = result.guardrailResult.violations
      .map((v) => v.detail)
      .join("; ");
    return {
      ok: false,
      text: `Blog article was blocked by guardrails: ${violations}`,
      topicTitle: topic.title,
    };
  }

  // Record the generation
  if (topic.id !== "adhoc") {
    try {
      await deps.db.insert(blogGenerations).values({
        topicId: topic.id,
        articleHtml: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      await deps.db
        .update(blogTopics)
        .set({ status: "published", updatedAt: new Date() })
        .where(eq(blogTopics.id, topic.id));
    } catch {
      // Non-fatal — article was generated even if recording fails
    }
  }

  return {
    ok: true,
    text: result.text,
    topicTitle: topic.title,
  };
}
