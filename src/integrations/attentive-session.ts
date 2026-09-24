/**
 * Persisting the Attentive browser session (#95).
 *
 * The scraper logs in fresh every run and asks Slack for an SMS 2FA code that
 * nobody answers, so Attentive reporting has been dark for days. The stored
 * session explains why: **4 cookies, none httpOnly, and not one of them a
 * session cookie** — `_ga`, `_dd_s`, `AMP_*`. All analytics. The localStorage
 * captured alongside it is Amplitude, Pendo and Zendesk. Nothing that could
 * authenticate anything.
 *
 * Two things were wrong with how it was captured:
 *
 * 1. **`sessionStorage` was never captured.** It is the one place an SPA can
 *    keep a token that neither `context.cookies()` nor `localStorage` would
 *    show, and nothing had looked there.
 * 2. **The capture was hand-rolled.** `storageState()` is Playwright's own
 *    mechanism, returns cookies for every domain the context has touched
 *    including httpOnly ones, and is consumed directly by `newContext`. The
 *    manual version also restored localStorage by navigating first and then
 *    calling `setItem`, which runs AFTER the app has booted and read it.
 *
 * This module is the pure half: the stored format, its migrations, and the
 * judgement about whether a captured session could possibly authenticate.
 * Whether it does is the browser's business.
 */

/** Cookies whose presence proves nothing — analytics, not authentication. */
export const NON_AUTH_COOKIE_PATTERNS = [
  /^_ga/i, /^_gid$/i, /^_gcl/i, /^_fbp$/i, /^_dd_s$/i,
  /^AMP_/i, /^_pendo/i, /^ZD-/i, /^__cf/i, /^_hj/i, /^ajs_/i,
];

export function isAuthCandidateCookie(name: string): boolean {
  return !NON_AUTH_COOKIE_PATTERNS.some((p) => p.test(name));
}

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface StorageStateLike {
  cookies: StoredCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export interface SessionRecord {
  version: 2;
  storageState: StorageStateLike;
  /** Per origin. Not part of storageState, and captured separately. */
  sessionStorage: Record<string, Record<string, string>>;
  capturedAt: string;
}

/**
 * What a captured session actually contains.
 *
 * Returned and stored rather than logged, because "we saved a session" and "we
 * saved four analytics cookies" printed the same line for the life of this
 * feature and the second is why every run needs a 2FA code.
 */
export interface SessionDiagnosis {
  cookies: number;
  httpOnlyCookies: number;
  /** Cookies that are not recognisably analytics — the only ones that could authenticate. */
  authCandidateCookies: string[];
  localStorageKeys: number;
  sessionStorageKeys: number;
  /** False when nothing in the capture could possibly log anyone in. */
  couldAuthenticate: boolean;
  reason: string;
}

export function diagnoseSession(record: SessionRecord): SessionDiagnosis {
  const cookies = record.storageState.cookies ?? [];
  const authCandidates = cookies.filter((c) => isAuthCandidateCookie(c.name)).map((c) => c.name);
  const localStorageKeys = (record.storageState.origins ?? []).reduce(
    (n, o) => n + o.localStorage.length,
    0,
  );
  const sessionStorageKeys = Object.values(record.sessionStorage ?? {}).reduce(
    (n, store) => n + Object.keys(store).length,
    0,
  );

  const couldAuthenticate = authCandidates.length > 0 || sessionStorageKeys > 0;
  return {
    cookies: cookies.length,
    httpOnlyCookies: cookies.filter((c) => c.httpOnly).length,
    authCandidateCookies: authCandidates,
    localStorageKeys,
    sessionStorageKeys,
    couldAuthenticate,
    reason: couldAuthenticate
      ? `Captured ${authCandidates.length} non-analytics cookie(s) and ${sessionStorageKeys} sessionStorage key(s).`
      : `Nothing here can authenticate: ${cookies.length} cookie(s), all recognisably analytics, ` +
        `and no sessionStorage. Reusing this session will land on the sign-in page and trigger 2FA.`,
  };
}

/**
 * Reads whatever is in the database, whichever format it was written in.
 *
 * Two older shapes exist: a bare cookie array, and `{ cookies, localStorage }`.
 * Both are upgraded rather than discarded — a stale session that still works is
 * worth more than a clean slate that needs a 2FA code.
 */
export function parseStoredSession(json: string): SessionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  if (Array.isArray(parsed)) {
    return {
      version: 2,
      storageState: { cookies: parsed as StoredCookie[], origins: [] },
      sessionStorage: {},
      capturedAt: "",
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.version === 2 && typeof obj.storageState === "object" && obj.storageState !== null) {
    return {
      version: 2,
      storageState: obj.storageState as StorageStateLike,
      sessionStorage: (obj.sessionStorage as Record<string, Record<string, string>>) ?? {},
      capturedAt: typeof obj.capturedAt === "string" ? obj.capturedAt : "",
    };
  }

  // The `{ cookies, localStorage }` shape. localStorage was stored flat, with
  // no origin, so it is attributed to the app origin on the way in.
  if (Array.isArray(obj.cookies)) {
    const flat = (obj.localStorage as Record<string, string> | undefined) ?? {};
    const entries = Object.entries(flat).map(([name, value]) => ({ name, value }));
    return {
      version: 2,
      storageState: {
        cookies: obj.cookies as StoredCookie[],
        origins: entries.length > 0
          ? [{ origin: "https://ui.attentivemobile.com", localStorage: entries }]
          : [],
      },
      sessionStorage: {},
      capturedAt: "",
    };
  }

  return null;
}

export function serialiseSession(record: SessionRecord): string {
  return JSON.stringify(record);
}
