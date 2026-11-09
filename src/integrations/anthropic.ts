/**
 * Anthropic API client — the seam between our code and the Claude API.
 * Tests mock this interface; production uses the real SDK.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface PromptImage {
  /** Shown immediately before the image — "Frame at 3s", "Slide 2". */
  label?: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: Buffer;
}

export interface GenerateOptions {
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Images to look at, in order, before the prompt. */
  images?: PromptImage[];
}

/**
 * The user turn: the prompt alone, or each image after its label and the
 * prompt last.
 */
export function buildUserContent(prompt: string, images?: PromptImage[]): string | Anthropic.ContentBlockParam[] {
  if (!images || images.length === 0) return prompt;
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const image of images) {
    if (image.label) blocks.push({ type: "text", text: image.label });
    blocks.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data.toString("base64") } });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface AnthropicClient {
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult>;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

export function createAnthropicClient(apiKey: string): AnthropicClient {
  const sdk = new Anthropic({ apiKey });

  return {
    async generate(prompt, options = {}) {
      const response = await sdk.messages.create({
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: options.temperature,
        system: options.system,
        messages: [{ role: "user", content: buildUserContent(prompt, options.images) }],
      });

      // Extract text from content blocks
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        text,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stop_reason ?? "unknown",
      };
    },
  };
}
