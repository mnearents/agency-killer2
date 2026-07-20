/**
 * Blog generation handler — the vertical integration point for
 * "!blog create" and the weekly scheduled blog-generate task.
 *
 * Blogs use a neutral, friendly, SEO-optimized tone — NOT Tara's brand
 * voice (which sounds forced in long-form content).
 */

import { buildBlogRequest, type BlogTopic } from "@/domain/blog/prompt";
import type { OrchestratorRequest, OrchestratorResult } from "@/ai/orchestrator";
import { formatOrchestratorResult, type SlackResponse } from "../formatter";

export interface BlogGenerateDeps {
  getNextTopic: () => Promise<BlogTopic | null>;
  getBrandContext: () => Promise<string>;
  runOrchestrator: (request: OrchestratorRequest) => Promise<OrchestratorResult>;
  voiceBannedWords?: string[];
}

export interface BlogGenerateParams {
  topic?: string;
}

export async function handleBlogGenerate(
  deps: BlogGenerateDeps,
  params: BlogGenerateParams
): Promise<SlackResponse> {
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

  const brandContext = await deps.getBrandContext();

  const request = buildBlogRequest({
    topic,
    brandContext,
    voiceBannedWords: deps.voiceBannedWords,
  });

  const result = await deps.runOrchestrator(request);

  return formatOrchestratorResult(result, "Blog Article");
}
