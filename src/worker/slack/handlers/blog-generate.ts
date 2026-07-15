/**
 * Blog generation handler — the vertical integration point for
 * "!blog create" and the weekly scheduled blog-generate task.
 *
 * Wires together: topic selection → brand context → voice prompt →
 * blog prompt (with AI-writing avoidance) → orchestrator → response.
 *
 * Dependencies injected for full mockability.
 */

import { buildBlogRequest, type BlogTopic } from "@/domain/blog/prompt";
import type { VoicePromptResult } from "@/domain/voice/voice";
import type { OrchestratorResult } from "@/ai/orchestrator";
import { formatOrchestratorResult, type SlackResponse } from "../formatter";

export interface BlogGenerateDeps {
  getNextTopic: () => Promise<BlogTopic | null>;
  getBrandContext: () => Promise<string>;
  runOrchestrator: (request: { prompt: string; system?: string; guardrails?: Record<string, unknown> }) => Promise<OrchestratorResult>;
  voice: VoicePromptResult;
}

export interface BlogGenerateParams {
  topic?: string;
}

export async function handleBlogGenerate(
  deps: BlogGenerateDeps,
  params: BlogGenerateParams
): Promise<SlackResponse> {
  // Step 1: Get the topic — override from params or next pending topic
  let topic: BlogTopic | null;

  if (params.topic) {
    topic = { title: params.topic };
  } else {
    topic = await deps.getNextTopic();
  }

  if (!topic) {
    return {
      text: "No pending topics to generate. Add one with `!blog create <topic>`.",
      isError: false,
    };
  }

  // Step 2: Get brand context for the prompt
  const brandContext = await deps.getBrandContext();

  // Step 3: Build the blog request (wires voice + AI-writing avoidance + guardrails)
  const request = buildBlogRequest({
    topic,
    voice: deps.voice,
    brandContext,
  });

  // Step 4: Run through the orchestrator
  const result = await deps.runOrchestrator(request);

  // Step 5: Format for Slack
  return formatOrchestratorResult(result, "Blog Article");
}
