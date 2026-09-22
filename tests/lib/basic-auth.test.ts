import { describe, it, expect } from "vitest";
import { checkBasicAuth } from "@/lib/basic-auth";

const CONFIG = { user: "matt", password: "correct-horse" };
const header = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

describe("checkBasicAuth", () => {
  it("accepts the configured credentials", () => {
    expect(checkBasicAuth(header("matt", "correct-horse"), CONFIG)).toEqual({ ok: true });
  });

  // The failure that matters: an unset variable on Railway is the normal way a
  // deploy goes wrong, and an auth check that switches itself off when
  // misconfigured leaves a deployment that still looks protected.
  it("denies everything when no password is configured", () => {
    expect(checkBasicAuth(header("matt", "correct-horse"), { user: "matt", password: undefined }))
      .toEqual({ ok: false, reason: "not_configured" });
  });

  it("denies everything when no user is configured", () => {
    expect(checkBasicAuth(header("matt", "correct-horse"), { user: undefined, password: "x" }))
      .toEqual({ ok: false, reason: "not_configured" });
  });

  it("denies an empty-string password rather than treating it as configured", () => {
    expect(checkBasicAuth(header("matt", ""), { user: "matt", password: "" }).ok).toBe(false);
  });

  it("rejects a wrong password", () => {
    expect(checkBasicAuth(header("matt", "wrong"), CONFIG)).toEqual({
      ok: false, reason: "bad_credentials",
    });
  });

  it("rejects a wrong user", () => {
    expect(checkBasicAuth(header("tara", "correct-horse"), CONFIG)).toEqual({
      ok: false, reason: "bad_credentials",
    });
  });

  it("distinguishes a missing header from a wrong credential", () => {
    expect(checkBasicAuth(null, CONFIG)).toEqual({ ok: false, reason: "missing_header" });
  });

  it("rejects a non-Basic scheme", () => {
    expect(checkBasicAuth("Bearer abc123", CONFIG)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a header with no colon in it", () => {
    expect(checkBasicAuth(`Basic ${Buffer.from("nocolon").toString("base64")}`, CONFIG)).toEqual({
      ok: false, reason: "malformed",
    });
  });

  it("accepts a password containing a colon, splitting on the first only", () => {
    expect(checkBasicAuth(header("matt", "a:b:c"), { user: "matt", password: "a:b:c" }))
      .toEqual({ ok: true });
  });

  it("is case-insensitive about the scheme name", () => {
    expect(checkBasicAuth(header("matt", "correct-horse").replace("Basic", "basic"), CONFIG))
      .toEqual({ ok: true });
  });

  // A prefix that compares equal for its length would be the classic bug.
  it("rejects a password that is a prefix of the real one", () => {
    expect(checkBasicAuth(header("matt", "correct"), CONFIG).ok).toBe(false);
  });

  // The padding used to make the compare constant-time zero-fills the shorter
  // side, so without an explicit length check a trailing NUL compares equal to
  // the real password. This is the case that guard exists for.
  it("rejects a password that is the real one plus a trailing NUL", () => {
    expect(checkBasicAuth(header("matt", "correct-horse\u0000"), CONFIG).ok).toBe(false);
  });

  it("rejects a user that is the real one plus a trailing NUL", () => {
    expect(checkBasicAuth(header("matt\u0000", "correct-horse"), CONFIG).ok).toBe(false);
  });

  it("rejects a password that extends the real one", () => {
    expect(checkBasicAuth(header("matt", "correct-horse-battery"), CONFIG).ok).toBe(false);
  });
});
