/**
 * AssemblyAI client — transcribes audio/video for reel content awareness.
 * The seam between our code and AssemblyAI's API.
 *
 * API docs: https://www.assemblyai.com/docs
 */

const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";

export interface TranscriptResult {
  id: string;
  status: "completed" | "error" | "queued" | "processing";
  text: string | null;
  error?: string;
}

export interface AssemblyAiClient {
  /**
   * Submit a media URL for transcription and wait for the result.
   * Returns the full transcript text, or null if transcription failed.
   */
  transcribe(mediaUrl: string): Promise<TranscriptResult>;
}

interface SubmitResponse {
  id: string;
  status: string;
}

interface PollResponse {
  id: string;
  status: string;
  text: string | null;
  error?: string;
}

const MAX_POLLS = 60;
const POLL_INTERVAL_MS = 5000;

export function createAssemblyAiClient(apiKey: string): AssemblyAiClient {
  const headers = {
    authorization: apiKey,
    "content-type": "application/json",
  };

  return {
    async transcribe(mediaUrl) {
      // Step 1: Submit transcription request
      console.log(`[assemblyai] Submitting transcription for: ${mediaUrl.slice(0, 80)}...`);
      const submitResponse = await fetch(`${ASSEMBLYAI_BASE}/transcript`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audio_url: mediaUrl }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        throw new Error(`AssemblyAI submit error (${submitResponse.status}): ${errorText}`);
      }

      const { id } = (await submitResponse.json()) as SubmitResponse;
      console.log(`[assemblyai] Transcript ${id} queued`);

      // Step 2: Poll until complete
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        const pollResponse = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, {
          headers,
        });

        if (!pollResponse.ok) {
          const errorText = await pollResponse.text();
          throw new Error(`AssemblyAI poll error (${pollResponse.status}): ${errorText}`);
        }

        const result = (await pollResponse.json()) as PollResponse;

        if (result.status === "completed") {
          console.log(`[assemblyai] Transcript ${id} completed (${result.text?.length ?? 0} chars)`);
          return {
            id,
            status: "completed" as const,
            text: result.text,
          };
        }

        if (result.status === "error") {
          console.error(`[assemblyai] Transcript ${id} failed: ${result.error}`);
          return {
            id,
            status: "error" as const,
            text: null,
            error: result.error,
          };
        }

        // Still processing — continue polling
      }

      // Timed out
      return {
        id,
        status: "processing" as const,
        text: null,
        error: "Transcription timed out after polling",
      };
    },
  };
}
