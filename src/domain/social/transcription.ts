/**
 * When to attempt a transcript, and what to record about the attempt.
 *
 * The bug this replaces: a video with no transcript was stored as a
 * kb_documents row reading "(No audio transcript available)" so the next run
 * would see a row and skip. That made a transient AssemblyAI failure permanent
 * and indistinguishable from a genuinely silent video — 85 of 134 reels ended
 * up in that state, 63% of the corpus, with the two recent high-volume months
 * at 21% and 38% against 67-80% earlier, which is the shape of rate limiting
 * rather than of reels suddenly having no audio.
 *
 * So the outcome is recorded, and only the outcomes that could change are
 * retried. Pure — no database, no clock, no network.
 */

export type TranscriptionStatus = "ok" | "no-audio" | "error" | "unknown";

/**
 * Attempts before giving up on a retryable failure.
 *
 * Bounded because an unreachable video would otherwise be retried every day
 * forever, spending an API call each time to learn the same thing. Three is
 * enough to ride out a rate limit or an outage and small enough that a
 * permanently broken media URL costs three calls, not three hundred.
 */
export const MAX_TRANSCRIPTION_ATTEMPTS = 3;

/** Statuses that can still change. `no-audio` and `ok` are settled. */
export const RETRYABLE_STATUSES: readonly TranscriptionStatus[] = ["error", "unknown"];

export interface TranscriptionState {
  status: TranscriptionStatus | null;
  attempts: number;
}

export interface AttemptDecision {
  attempt: boolean;
  reason: "never-attempted" | "retryable" | "settled" | "attempts-exhausted";
}

/**
 * Whether to try transcribing this post now.
 *
 * `settled` covers both success and a measured silence: retrying either spends
 * money to learn what is already recorded.
 */
export function shouldAttemptTranscription(state: TranscriptionState): AttemptDecision {
  if (state.status === null) return { attempt: true, reason: "never-attempted" };
  if (!RETRYABLE_STATUSES.includes(state.status)) return { attempt: false, reason: "settled" };
  if (state.attempts >= MAX_TRANSCRIPTION_ATTEMPTS) {
    return { attempt: false, reason: "attempts-exhausted" };
  }
  return { attempt: true, reason: "retryable" };
}

export interface TranscribeResult {
  status: string;
  text?: string | null;
}

export interface ClassifiedTranscription {
  status: TranscriptionStatus;
  text: string | null;
  /** What to record about a failure. Null when there is nothing to explain. */
  detail: string | null;
}

/**
 * Turns a transcriber response — or a throw — into a recorded outcome.
 *
 * The distinction that matters: a completed call returning nothing is
 * `no-audio` and terminal, while a throw or any other status is `error` and
 * will be tried again. Previously both produced the same placeholder row.
 */
export function classifyTranscription(
  result: TranscribeResult | null,
  error?: unknown,
): ClassifiedTranscription {
  if (error !== undefined && error !== null) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", text: null, detail: message.slice(0, 300) };
  }
  if (result === null) {
    return { status: "error", text: null, detail: "transcriber returned nothing" };
  }
  if (result.status !== "completed") {
    return { status: "error", text: null, detail: `status: ${result.status}` };
  }
  const text = (result.text ?? "").trim();
  if (text === "") {
    return { status: "no-audio", text: null, detail: null };
  }
  return { status: "ok", text, detail: null };
}
