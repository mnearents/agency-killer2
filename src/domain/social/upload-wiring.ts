/**
 * The real clients behind the upload routes, built per request from the web
 * service's environment. Kept out of the route files so the wiring is one
 * place, asserted by tests/app/social-upload-wiring.test.ts.
 */

import { db } from "@/lib/db";
import { createAnthropicClient } from "@/integrations/anthropic";
import { createAssemblyAiClient } from "@/integrations/assemblyai";
import { createEmbeddingClient } from "@/integrations/openai";
import { createFfmpegToolkit } from "@/integrations/video-frames";
import { saveStreamToTemp } from "@/integrations/media-download";
import type { BasicAuthConfig } from "@/lib/basic-auth";
import { analyseUploadedReel } from "./upload";
import type { UploadHttpDeps } from "./upload-http";

/** The cost form's credentials: the dashboard's one password. */
export function uploadAuth(): BasicAuthConfig {
  return { user: process.env.COST_FORM_USER, password: process.env.COST_FORM_PASSWORD };
}

export function uploadDeps(): UploadHttpDeps {
  return {
    auth: uploadAuth(),
    saveBody: (body, max) => saveStreamToTemp(body, max, "video"),
    analyse: (input) => {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set on the web service — uploads cannot be analysed");
      const assemblyKey = process.env.ASSEMBLYAI_API_KEY;
      const openAiKey = process.env.OPENAI_API_KEY;
      if (!assemblyKey) console.error("[social:upload] ASSEMBLYAI_API_KEY not set — speech in uploads is not transcribed");
      return analyseUploadedReel(
        {
          db: db(),
          anthropic: createAnthropicClient(anthropicKey),
          video: createFfmpegToolkit(),
          transcriber: assemblyKey ? createAssemblyAiClient(assemblyKey) : undefined,
          embeddingClient: openAiKey ? createEmbeddingClient(openAiKey) : undefined,
          now: () => new Date(),
        },
        input,
      );
    },
  };
}
