/**
 * Blog generation prompt assembly — builds prompts for SEO/GEO optimized
 * blog articles with AI-writing avoidance.
 *
 * IMPORTANT: Blogs do NOT use Tara's brand voice. Her voice sounds forced
 * in long-form blog content. Instead, blogs use a friendly, neutral,
 * SEO-optimized tone. The AI-writing avoidance rules still apply.
 */

import type { GuardrailOptions } from "@/ai/guardrails";
import type { OrchestratorRequest } from "@/ai/orchestrator";
import {
  AI_WRITING_AVOIDANCE_INSTRUCTIONS,
  AI_WRITING_BANNED_WORDS,
} from "./ai-writing-rules";

export interface BlogTopic {
  title: string;
  description?: string;
  targetDate?: string;
  tags?: string[];
}

export interface BlogPromptInput {
  topic: BlogTopic;
  brandContext?: string;
  /** Voice banned words to merge with AI-writing words (for guardrails only, not tone) */
  voiceBannedWords?: string[];
}

const BLOG_SYSTEM_PROMPT = `You are a blog writer for Rad & Happy, a stationery and lifestyle brand. Your tone is friendly, approachable, and helpful — like a knowledgeable friend sharing tips, not a corporation or an influencer.

Write in a way that feels natural and human. Use short sentences mixed with longer ones. Be specific and practical. Don't try to sound excited or bubbly — just be genuinely helpful and clear.

The reader is someone who cares about organization, creativity, and making their daily life a little better. They're probably a parent, teacher, or creative professional.`;

export function buildBlogGuardrails(
  voiceBannedWords: string[] = []
): GuardrailOptions {
  // Merge voice banned words with AI-writing banned words for guardrails
  const allBanned = new Set([
    ...voiceBannedWords.map((w) => w.toLowerCase()),
    ...AI_WRITING_BANNED_WORDS.map((w) => w.toLowerCase()),
  ]);

  return {
    bannedWords: [...allBanned],
    checkFabricatedStats: true,
    checkPii: true,
    maxLength: 30000,
  };
}

export function buildBlogRequest(
  input: BlogPromptInput
): OrchestratorRequest {
  const { topic, brandContext, voiceBannedWords } = input;

  // System prompt: neutral blog tone + AI-writing avoidance (NOT Tara's voice)
  const system = BLOG_SYSTEM_PROMPT + "\n\n" + AI_WRITING_AVOIDANCE_INSTRUCTIONS;

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
- Tone: friendly and helpful, not salesy or overly enthusiastic
- DO NOT sound like AI wrote this — follow the AI Writing Avoidance rules strictly`;

  const guardrails = buildBlogGuardrails(voiceBannedWords);

  return { prompt, system, guardrails };
}
