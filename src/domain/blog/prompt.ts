/**
 * Blog generation prompt assembly — builds prompts for SEO/GEO optimized
 * blog articles with AI-writing avoidance.
 */

import type { GuardrailOptions } from "@/ai/guardrails";
import type { OrchestratorRequest } from "@/ai/orchestrator";
import type { VoicePromptResult } from "@/domain/voice/voice";
import {
  AI_WRITING_AVOIDANCE_INSTRUCTIONS,
  mergeAiWritingBannedWords,
} from "./ai-writing-rules";

export interface BlogTopic {
  title: string;
  description?: string;
  targetDate?: string;
  tags?: string[];
}

export interface BlogPromptInput {
  topic: BlogTopic;
  voice: VoicePromptResult;
  brandContext?: string;
}

export function buildBlogGuardrails(
  voiceGuardrails: GuardrailOptions
): GuardrailOptions {
  return {
    ...voiceGuardrails,
    bannedWords: mergeAiWritingBannedWords(voiceGuardrails.bannedWords ?? []),
    checkFabricatedStats: true,
    checkPii: true,
    maxLength: 30000, // articles can be long
  };
}

export function buildBlogRequest(
  input: BlogPromptInput
): OrchestratorRequest {
  const { topic, voice, brandContext } = input;

  // System prompt: voice + AI-writing avoidance
  const system = voice.systemPrompt + "\n\n" + AI_WRITING_AVOIDANCE_INSTRUCTIONS;

  let prompt = `Write an SEO-optimized blog article in HTML format.\n\n`;
  prompt += `## Topic\n${topic.title}\n`;

  if (topic.description) {
    prompt += `\n## Description\n${topic.description}\n`;
  }

  if (topic.tags && topic.tags.length > 0) {
    prompt += `\n## Tags/Keywords\n${topic.tags.join(", ")}\n`;
  }

  if (brandContext) {
    prompt += `\n## Brand Context\n${brandContext}\n`;
  }

  prompt += `
## Requirements
- Write the article body as clean HTML (use <h2>, <h3>, <p>, <ul>/<li> tags)
- Target 800-1500 words
- Include the primary keyword naturally in the title, first paragraph, and at least 2 subheadings
- Write in Tara's voice (match the writing samples)
- DO NOT sound like AI wrote this — follow the AI Writing Avoidance rules strictly`;

  const guardrails = buildBlogGuardrails(voice.guardrailOptions);

  return { prompt, system, guardrails };
}
