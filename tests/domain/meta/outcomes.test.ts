import { describe, it, expect } from "vitest";
import { classifyOutcome } from "@/domain/meta/outcomes";
import { MetaApiError } from "@/integrations/meta-api";

/**
 * The bug these tests exist to prevent:
 *
 * `meta_insights` sat empty for months while the daily task logged
 * "Done: 0 insights" every single day. Four different situations — never ran,
 * ran and found nothing, token dead, API broken — all produced that same line.
 *
 * Every test below asserts that two situations which used to look identical now
 * resolve to different outcomes.
 */
describe("classifyOutcome", () => {
  it("reports not-configured when credentials are missing", () => {
    // The actual production failure: META_AD_ACCOUNT_ID was never set, so the
    // task returned before making a single API call.
    const result = classifyOutcome({ configured: false, rowsWritten: 0 });
    expect(result.outcome).toBe("not-configured");
  });

  it("reports no-data when a clean run genuinely returns nothing", () => {
    const result = classifyOutcome({ configured: true, rowsWritten: 0 });
    expect(result.outcome).toBe("no-data");
  });

  it("reports ok when rows were written", () => {
    const result = classifyOutcome({ configured: true, rowsWritten: 412 });
    expect(result.outcome).toBe("ok");
    expect(result.errorCode).toBeNull();
  });

  it("does not let a zero-row run and an unconfigured run collapse together", () => {
    const noData = classifyOutcome({ configured: true, rowsWritten: 0 });
    const unconfigured = classifyOutcome({ configured: false, rowsWritten: 0 });
    expect(noData.outcome).not.toBe(unconfigured.outcome);
  });

  it("reports auth-failed on an expired or invalid token (code 190)", () => {
    const err = new MetaApiError("Error validating access token", 190, 463);
    const result = classifyOutcome({ configured: true, rowsWritten: 0, error: err });
    expect(result.outcome).toBe("auth-failed");
    expect(result.errorCode).toBe(190);
  });

  it("reports auth-failed on a permissions error (code 200)", () => {
    const err = new MetaApiError("Permissions error", 200);
    expect(classifyOutcome({ configured: true, rowsWritten: 0, error: err }).outcome)
      .toBe("auth-failed");
  });

  it.each([
    ["app throttle", 4],
    ["user request limit", 17],
    ["calls per second", 613],
    ["business use case throttle", 80000],
  ])("reports rate-limited on %s (code %i)", (_label, code) => {
    const err = new MetaApiError("throttled", code);
    expect(classifyOutcome({ configured: true, rowsWritten: 0, error: err }).outcome)
      .toBe("rate-limited");
  });

  it("reports api-error for an unrecognised Meta error code", () => {
    const err = new MetaApiError("Something else broke", 999);
    const result = classifyOutcome({ configured: true, rowsWritten: 0, error: err });
    expect(result.outcome).toBe("api-error");
    expect(result.errorCode).toBe(999);
  });

  it("reports api-error for a non-Meta failure such as a network drop", () => {
    const result = classifyOutcome({
      configured: true,
      rowsWritten: 0,
      error: new Error("fetch failed: ECONNRESET"),
    });
    expect(result.outcome).toBe("api-error");
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toContain("ECONNRESET");
  });

  it("treats an error as a failure even when some rows were already written", () => {
    // A partial write must never be reported as success — that is precisely how
    // a broken sync disguises itself as a working one.
    const err = new MetaApiError("throttled", 17);
    const result = classifyOutcome({ configured: true, rowsWritten: 300, error: err });
    expect(result.outcome).toBe("rate-limited");
    expect(result.rowsWritten).toBe(300);
  });

  it("carries the error message through for a human to read", () => {
    const err = new MetaApiError("Error validating access token: Session expired", 190);
    const result = classifyOutcome({ configured: true, rowsWritten: 0, error: err });
    expect(result.errorMessage).toContain("Session expired");
  });

  it("leaves errorMessage null on a healthy run", () => {
    expect(classifyOutcome({ configured: true, rowsWritten: 5 }).errorMessage).toBeNull();
  });
});

describe("MetaApiError.fromResponseBody", () => {
  it("extracts code and subcode from a real Meta error envelope", () => {
    // Shape captured live from act_1095043578864346 on 2026-09-02.
    const body = JSON.stringify({
      error: {
        message: "Requesting for deleted objects is not supported in this endpoint.",
        type: "OAuthException",
        code: 100,
        error_subcode: 1815001,
        fbtrace_id: "ALDddvqe6EtpKk-D6fdHJ7B",
      },
    });
    const err = MetaApiError.fromResponseBody(body, 400);
    expect(err.code).toBe(100);
    expect(err.subcode).toBe(1815001);
    expect(err.message).toContain("deleted objects");
  });

  it("degrades to an api-error rather than throwing on an unparseable body", () => {
    const err = MetaApiError.fromResponseBody("<html>502 Bad Gateway</html>", 502);
    expect(err.code).toBeNull();
    expect(classifyOutcome({ configured: true, rowsWritten: 0, error: err }).outcome)
      .toBe("api-error");
  });
});
