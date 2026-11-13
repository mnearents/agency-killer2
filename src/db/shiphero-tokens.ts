/**
 * ShipHero's OAuth tokens, held where the app can update them.
 *
 * Not an environment variable: a refresh can return a NEW refresh token, and
 * the old one must be replaced when it does. So they live in one row of
 * `shiphero_tokens`, encrypted (AES-256-GCM) with `SHIPHERO_TOKEN_KEY`, which
 * is on the worker only — a read of the database, a backup or the MCP's
 * connection does not reveal them.
 *
 * The access token (28 days) is reused until it is within
 * REFRESH_BEFORE_EXPIRY_MS of expiring, then refreshed under a row lock, so
 * two processes never spend one rotating refresh token twice. A refreshed
 * token whose scope differs from what was granted is refused and nothing is
 * stored. Tokens are never logged or returned anywhere but the client.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { shipheroTokens } from "./schema";
import { checkGrantedScopes, refreshTokens } from "@/integrations/shiphero-auth";

export const REFRESH_BEFORE_EXPIRY_MS = 3 * 86_400_000;
const ROW_ID = "default";

export class ShipHeroNotAuthorisedError extends Error {
  constructor() {
    super("ShipHero is not signed in: no token is stored. Run `pnpm shiphero:auth` on Matt's machine.");
    this.name = "ShipHeroNotAuthorisedError";
  }
}

export function parseTokenKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) throw new Error("SHIPHERO_TOKEN_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
}

/** iv.tag.ciphertext, each base64. */
export function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptToken(stored: string, key: Buffer): string {
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope: string;
}

/** The seam: the database store below, or a memory one in tests. */
export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  /** Runs `fn` with the row locked; what it returns under `save` replaces the row. */
  withLock<T>(fn: (current: StoredTokens | null) => Promise<{ result: T; save?: StoredTokens }>): Promise<T>;
}

export function createDbTokenStore(db: Db, key: Buffer): TokenStore {
  const decode = (r: typeof shipheroTokens.$inferSelect): StoredTokens => ({
    accessToken: decryptToken(r.accessTokenEnc, key),
    refreshToken: decryptToken(r.refreshTokenEnc, key),
    expiresAt: r.expiresAt,
    scope: r.scope,
  });
  return {
    async load() {
      const [row] = await db.select().from(shipheroTokens).where(eq(shipheroTokens.id, ROW_ID));
      return row ? decode(row) : null;
    },
    async withLock(fn) {
      return db.transaction(async (tx) => {
        const [row] = (await tx.execute(sql`SELECT * FROM shiphero_tokens WHERE id = ${ROW_ID} FOR UPDATE`)) as unknown as Array<Record<string, unknown>>;
        const current = row
          ? decode({
              id: String(row.id), accessTokenEnc: String(row.access_token_enc), refreshTokenEnc: String(row.refresh_token_enc),
              expiresAt: new Date(row.expires_at as string), scope: String(row.scope),
              obtainedAt: new Date(row.obtained_at as string), refreshedAt: row.refreshed_at ? new Date(row.refreshed_at as string) : null,
            })
          : null;
        const out = await fn(current);
        if (out.save) await saveTokens(tx as unknown as Db, key, out.save, { refreshed: true });
        return out.result;
      });
    },
  };
}

/** Writes the one row, encrypted. Used by the sign-in script and by refreshes. */
export async function saveTokens(db: Db, key: Buffer, t: StoredTokens, opts: { refreshed: boolean }): Promise<void> {
  const now = new Date();
  const values = {
    id: ROW_ID,
    accessTokenEnc: encryptToken(t.accessToken, key),
    refreshTokenEnc: encryptToken(t.refreshToken, key),
    expiresAt: t.expiresAt,
    scope: t.scope,
    obtainedAt: now,
    refreshedAt: opts.refreshed ? now : null,
  };
  const { id: _id, obtainedAt: _obtained, ...update } = values;
  await db.insert(shipheroTokens).values(values).onConflictDoUpdate({
    target: shipheroTokens.id,
    set: opts.refreshed ? update : { ...update, obtainedAt: now },
  });
}

export async function hasShipHeroTokens(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: shipheroTokens.id }).from(shipheroTokens).where(eq(shipheroTokens.id, ROW_ID));
  return row !== undefined;
}

export interface TokenProvider {
  /** A live access token, refreshed first if it is near expiry. */
  getAccessToken(): Promise<string>;
  /** After a 401: refresh now, unless another process already replaced `rejected`. */
  forceRefresh(rejected: string): Promise<string>;
}

export function createShipHeroTokenProvider(deps: { store: TokenStore; fetchImpl?: typeof fetch; now?: () => Date }): TokenProvider {
  const now = deps.now ?? (() => new Date());
  let cached: StoredTokens | null = null;
  const fresh = (t: StoredTokens) => t.expiresAt.getTime() - now().getTime() > REFRESH_BEFORE_EXPIRY_MS;

  const refresh = (rejected: string | null) =>
    deps.store.withLock<string>(async (current) => {
      if (!current) throw new ShipHeroNotAuthorisedError();
      // Someone refreshed while we waited for the lock.
      if (rejected === null ? fresh(current) : current.accessToken !== rejected) {
        cached = current;
        return { result: current.accessToken };
      }
      const t = await refreshTokens({ refreshToken: current.refreshToken, fetchImpl: deps.fetchImpl });
      const scope = t.scope ?? current.scope;
      const check = checkGrantedScopes(scope);
      if (!check.ok) throw new Error(`Refusing the refreshed ShipHero token: ${check.reason}`);
      const next: StoredTokens = {
        accessToken: t.accessToken,
        refreshToken: t.refreshToken ?? current.refreshToken,
        expiresAt: new Date(now().getTime() + t.expiresInSeconds * 1000),
        scope,
      };
      cached = next;
      return { result: next.accessToken, save: next };
    });

  return {
    async getAccessToken() {
      if (cached && fresh(cached)) return cached.accessToken;
      const loaded = await deps.store.load();
      if (!loaded) throw new ShipHeroNotAuthorisedError();
      if (fresh(loaded)) {
        cached = loaded;
        return loaded.accessToken;
      }
      return refresh(null);
    },
    forceRefresh(rejected) {
      return refresh(rejected);
    },
  };
}
