/**
 * AssemblyAI client — transcribes audio/video for reel content awareness.
 * The seam between our code and AssemblyAI's API.
 *
 * API docs: https://www.assemblyai.com/docs
 */

const ASSEMBLYAI_BASE = "https://api.assemblyai.com/v2";

/** One spoken word, timed in milliseconds from the start of the media. */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptResult {
  id: string;
  status: "completed" | "error" | "queued" | "processing";
  text: string | null;
  error?: string;
  /** Word timings. Present on a completed transcript. */
  words?: TranscriptWord[];
  /** Length of the media in milliseconds, as AssemblyAI measured it. */
  durationMs?: number | null;
}

export interface AssemblyAiClient {
  /**
   * Submit a media URL for transcription and wait for the result.
   * Returns the full transcript text, or null if transcription failed.
   */
  transcribe(mediaUrl: string): Promise<TranscriptResult>;
  /**
   * IDs of every completed transcript the account holds, newest first.
   * AssemblyAI keeps transcripts until they are deleted, so this is how words
   * discarded by an earlier version of the sync are recovered without paying
   * to transcribe again.
   */
  listCompletedTranscriptIds(): Promise<string[]>;
  /** A transcript already made, with its words. Throws if it cannot be read. */
  getTranscript(id: string): Promise<TranscriptResult>;
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
  words?: { text: string; start: number; end: number; confidence: number }[] | null;
  /** Seconds. */
  audio_duration?: number | null;
}

interface ListResponse {
  transcripts: { id: string }[];
  page_details: { prev_url: string | null };
}

function toWords(words: PollResponse["words"]): TranscriptWord[] {
  return (words ?? []).map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence }));
}

function toDurationMs(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" ? Math.round(seconds * 1000) : null;
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
            words: toWords(result.words),
            durationMs: toDurationMs(result.audio_duration),
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

    async listCompletedTranscriptIds() {
      const ids: string[] = [];
      let url: string | null = `${ASSEMBLYAI_BASE}/transcript?limit=200&status=completed`;
      while (url) {
        const response = await fetch(url, { headers });
        // A page that fails fails the listing: a partial one would read as
        // transcripts that do not exist, and send their clips to be paid for again.
        if (!response.ok) {
          throw new Error(`AssemblyAI transcript list error (${response.status}): ${await response.text()}`);
        }
        const page = (await response.json()) as ListResponse;
        for (const t of page.transcripts) ids.push(t.id);
        url = page.page_details.prev_url;
      }
      return ids;
    },

    async getTranscript(id) {
      const response = await fetch(`${ASSEMBLYAI_BASE}/transcript/${id}`, { headers });
      if (!response.ok) {
        throw new Error(`AssemblyAI transcript fetch error (${response.status}): ${await response.text()}`);
      }
      const result = (await response.json()) as PollResponse;
      return {
        id: result.id,
        status: result.status as TranscriptResult["status"],
        text: result.text,
        error: result.error,
        words: toWords(result.words),
        durationMs: toDurationMs(result.audio_duration),
      };
    },
  };
}
