import { describe, it, expect } from "vitest";
import {
  parseStoredSession, serialiseSession, diagnoseSession, isAuthCandidateCookie,
  type SessionRecord, type StoredCookie,
} from "@/integrations/attentive-session";

const cookie = (name: string, over: Partial<StoredCookie> = {}): StoredCookie => ({
  name, value: "v", domain: ".attentivemobile.com", path: "/",
  expires: -1, httpOnly: false, secure: true, sameSite: "Lax", ...over,
});

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  version: 2,
  storageState: { cookies: [], origins: [] },
  sessionStorage: {},
  capturedAt: "2026-09-23T20:00:00.000Z",
  ...over,
});

describe("isAuthCandidateCookie", () => {
  // These are exactly what the live stored session contained — four cookies,
  // none of which could log anyone in.
  it("rejects the analytics cookies the live session was made of", () => {
    for (const name of ["_ga", "_ga_R0XHBXN8GN", "_dd_s", "AMP_7510089f5c"]) {
      expect(isAuthCandidateCookie(name), name).toBe(false);
    }
  });

  it("accepts something that could plausibly be a session", () => {
    for (const name of ["session", "sid", "auth_token", "attn_session"]) {
      expect(isAuthCandidateCookie(name), name).toBe(true);
    }
  });
});

describe("diagnoseSession", () => {
  // "We saved a session" and "we saved four analytics cookies" printed the
  // same line for the life of this feature.
  it("says a session of only analytics cookies cannot authenticate", () => {
    const d = diagnoseSession(record({
      storageState: { cookies: [cookie("_ga"), cookie("_dd_s")], origins: [] },
    }));
    expect(d.couldAuthenticate).toBe(false);
    expect(d.cookies).toBe(2);
    expect(d.authCandidateCookies).toEqual([]);
    expect(d.reason).toMatch(/trigger 2FA/);
  });

  it("says a session with a real cookie can", () => {
    const d = diagnoseSession(record({
      storageState: { cookies: [cookie("_ga"), cookie("attn_session", { httpOnly: true })], origins: [] },
    }));
    expect(d.couldAuthenticate).toBe(true);
    expect(d.authCandidateCookies).toEqual(["attn_session"]);
    expect(d.httpOnlyCookies).toBe(1);
  });

  // The remaining candidate: an SPA token that neither cookies nor
  // localStorage would show, which nothing had ever looked for.
  it("counts sessionStorage as able to authenticate on its own", () => {
    const d = diagnoseSession(record({
      storageState: { cookies: [cookie("_ga")], origins: [] },
      sessionStorage: { "https://ui.attentivemobile.com": { token: "abc" } },
    }));
    expect(d.couldAuthenticate).toBe(true);
    expect(d.sessionStorageKeys).toBe(1);
  });

  it("counts localStorage keys across origins", () => {
    const d = diagnoseSession(record({
      storageState: {
        cookies: [],
        origins: [
          { origin: "https://a", localStorage: [{ name: "x", value: "1" }] },
          { origin: "https://b", localStorage: [{ name: "y", value: "2" }, { name: "z", value: "3" }] },
        ],
      },
    }));
    expect(d.localStorageKeys).toBe(3);
  });

  // localStorage alone is not evidence: the live session had 16 keys of
  // Amplitude and Pendo and still could not authenticate.
  it("does not treat localStorage alone as able to authenticate", () => {
    const d = diagnoseSession(record({
      storageState: {
        cookies: [cookie("_ga")],
        origins: [{ origin: "https://ui.attentivemobile.com", localStorage: [{ name: "AMP_x", value: "1" }] }],
      },
    }));
    expect(d.couldAuthenticate).toBe(false);
  });

  it("reports an empty session as unable to authenticate", () => {
    expect(diagnoseSession(record()).couldAuthenticate).toBe(false);
  });
});

describe("parseStoredSession", () => {
  it("round-trips the current format", () => {
    const r = record({ storageState: { cookies: [cookie("s")], origins: [] } });
    expect(parseStoredSession(serialiseSession(r))).toEqual(r);
  });

  // A stale session that still works beats a clean slate needing a 2FA code.
  it("upgrades a bare cookie array", () => {
    const parsed = parseStoredSession(JSON.stringify([cookie("s")]));
    expect(parsed?.storageState.cookies).toHaveLength(1);
    expect(parsed?.sessionStorage).toEqual({});
  });

  it("upgrades the cookies-plus-localStorage shape, keeping both", () => {
    const parsed = parseStoredSession(JSON.stringify({
      cookies: [cookie("s")], localStorage: { a: "1", b: "2" },
    }));
    expect(parsed?.storageState.cookies).toHaveLength(1);
    expect(parsed?.storageState.origins[0].localStorage).toEqual([
      { name: "a", value: "1" }, { name: "b", value: "2" },
    ]);
  });

  it("omits the origin entirely when the old format had no localStorage", () => {
    expect(parseStoredSession(JSON.stringify({ cookies: [cookie("s")] }))?.storageState.origins)
      .toEqual([]);
  });

  it("returns null for unparseable JSON rather than throwing", () => {
    expect(parseStoredSession("{not json")).toBeNull();
  });

  it("returns null for a shape it does not recognise", () => {
    expect(parseStoredSession(JSON.stringify({ something: "else" }))).toBeNull();
  });
});
