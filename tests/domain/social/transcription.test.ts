import { describe, it, expect } from "vitest";
import {
  shouldAttemptTranscription,
  classifyTranscription,
  MAX_TRANSCRIPTION_ATTEMPTS,
  RETRYABLE_STATUSES,
  isCredentialFailure,
} from "@/domain/social/transcription";

describe("shouldAttemptTranscription", () => {
  it("attempts a post never tried before", () => {
    expect(shouldAttemptTranscription({ status: null, attempts: 0 })).toEqual({
      attempt: true, reason: "never-attempted",
    });
  });

  // The bug: a transient failure was written as a placeholder row, the next
  // run saw a row and skipped, and the failure became permanent.
  it("retries a post that errored", () => {
    expect(shouldAttemptTranscription({ status: "error", attempts: 1 })).toEqual({
      attempt: true, reason: "retryable",
    });
  });

  // The 85 backfilled posts, whose cause was discarded at the time.
  it("retries a post whose cause is unknown", () => {
    expect(shouldAttemptTranscription({ status: "unknown", attempts: 1 }).attempt).toBe(true);
  });

  it("does not retry a post already transcribed", () => {
    expect(shouldAttemptTranscription({ status: "ok", attempts: 1 })).toEqual({
      attempt: false, reason: "settled",
    });
  });

  // A measured silence is an answer. Retrying spends an API call to learn it
  // again.
  it("does not retry a post measured as having no audio", () => {
    expect(shouldAttemptTranscription({ status: "no-audio", attempts: 1 })).toEqual({
      attempt: false, reason: "settled",
    });
  });

  // Bounded, or a permanently broken media URL is retried every day forever.
  it("gives up after the attempt limit", () => {
    expect(shouldAttemptTranscription({
      status: "error", attempts: MAX_TRANSCRIPTION_ATTEMPTS,
    })).toEqual({ attempt: false, reason: "attempts-exhausted" });
  });

  it("still attempts on the last allowed try", () => {
    expect(shouldAttemptTranscription({
      status: "error", attempts: MAX_TRANSCRIPTION_ATTEMPTS - 1,
    }).attempt).toBe(true);
  });

  it("treats only error and unknown as retryable", () => {
    expect([...RETRYABLE_STATUSES].sort()).toEqual(["error", "unknown"]);
  });

  // The cap is for files that cannot be transcribed. A rejected key says
  // nothing about the file, and counting it stranded ten clips on a key that
  // had since been replaced.
  it("keeps retrying a failure caused by our credentials past the limit", () => {
    expect(shouldAttemptTranscription({
      status: "error",
      attempts: MAX_TRANSCRIPTION_ATTEMPTS + 2,
      detail: "AssemblyAI submit error (401): Authentication error, API token missing/invalid",
    })).toEqual({ attempt: true, reason: "retryable" });
  });

  it("still gives up on an ordinary failure past the limit", () => {
    expect(shouldAttemptTranscription({
      status: "error", attempts: MAX_TRANSCRIPTION_ATTEMPTS, detail: "status: error",
    })).toEqual({ attempt: false, reason: "attempts-exhausted" });
  });
});

describe("isCredentialFailure", () => {
  it.each([
    "AssemblyAI submit error (401): Authentication error, API token missing/invalid",
    "AssemblyAI poll error (403): forbidden",
    "Dropbox temporary link failed for /rad/footage/clip.mov: 401",
    "Dropbox token refresh failed: 400",
  ])("recognises %s", (detail) => {
    expect(isCredentialFailure(detail)).toBe(true);
  });

  it.each([
    "status: error",
    "429 rate limit exceeded",
    "Dropbox temporary link failed for /rad/401/img_0401.mov: 409",
    "transcriber returned nothing",
  ])("does not mistake %s for one", (detail) => {
    expect(isCredentialFailure(detail)).toBe(false);
  });

  it("is false when nothing was recorded", () => {
    expect(isCredentialFailure(null)).toBe(false);
  });
});

describe("classifyTranscription", () => {
  it("records a real transcript as ok", () => {
    expect(classifyTranscription({ status: "completed", text: "  hello there  " })).toEqual({
      status: "ok", text: "hello there", detail: null,
    });
  });

  // The distinction the placeholder row destroyed: a completed call returning
  // nothing is a measurement, and a throw is not.
  it("records a completed call with no text as no-audio", () => {
    expect(classifyTranscription({ status: "completed", text: "" })).toEqual({
      status: "no-audio", text: null, detail: null,
    });
  });

  it("treats whitespace-only text as no audio", () => {
    expect(classifyTranscription({ status: "completed", text: "   \n " }).status).toBe("no-audio");
  });

  it("treats a missing text field as no audio, not an error", () => {
    expect(classifyTranscription({ status: "completed" }).status).toBe("no-audio");
  });

  it("records a throw as a retryable error, keeping the message", () => {
    const c = classifyTranscription(null, new Error("429 rate limit exceeded"));
    expect(c.status).toBe("error");
    expect(c.detail).toContain("429");
  });

  it("records a non-completed status as a retryable error naming it", () => {
    expect(classifyTranscription({ status: "failed" })).toEqual({
      status: "error", text: null, detail: "status: failed",
    });
  });

  // AssemblyAI refuses silent b-roll outright rather than completing with
  // empty text. Read as an error, every silent clip burned three attempts and
  // was reported as broken.
  it.each([
    "language_detection cannot be performed on files with no spoken audio.",
    "File does not appear to contain audio. File type is video/quicktime (QuickTime video).",
  ])("records AssemblyAI's refusal %s as no-audio", (error) => {
    expect(classifyTranscription({ status: "error", error }))
      .toEqual({ status: "no-audio", text: null, detail: null });
  });

  // "status: error" alone is why the cause above went unseen for a week.
  it("keeps the transcriber's reason for any other failure", () => {
    expect(classifyTranscription({ status: "error", error: "Download error, unable to download" }))
      .toEqual({ status: "error", text: null, detail: "status: error — Download error, unable to download" });
  });

  it("records a null result as an error rather than silence", () => {
    expect(classifyTranscription(null).status).toBe("error");
  });

  it("truncates a long error so one failure cannot fill the column", () => {
    const c = classifyTranscription(null, new Error("x".repeat(1000)));
    expect(c.detail!.length).toBeLessThanOrEqual(300);
  });

  it("handles a thrown non-Error", () => {
    expect(classifyTranscription(null, "socket hang up").detail).toBe("socket hang up");
  });
});
