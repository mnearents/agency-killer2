import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptToken,
  decryptToken,
  parseTokenKey,
  createShipHeroTokenProvider,
  ShipHeroNotAuthorisedError,
  REFRESH_BEFORE_EXPIRY_MS,
  type TokenStore,
  type StoredTokens,
} from "@/db/shiphero-tokens";

const KEY = randomBytes(32);
const NOW = new Date("2026-11-13T12:00:00Z");
const DAY = 86_400_000;
const GRANTED = "openid profile offline_access view:orders view:shipments view:billing";

function memoryStore(initial: StoredTokens | null) {
  let row = initial;
  const saved: StoredTokens[] = [];
  const store: TokenStore = {
    load: async () => row,
    withLock: async (fn) => {
      const out = await fn(row);
      if (out.save) {
        row = out.save;
        saved.push(out.save);
      }
      return out.result;
    },
  };
  return { store, saved, current: () => row };
}

const held = (expiresInMs: number): StoredTokens => ({ accessToken: "A1", refreshToken: "R1", expiresAt: new Date(NOW.getTime() + expiresInMs), scope: GRANTED });
const tokenReply = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { status: 200 });

describe("token encryption", () => {
  it("round-trips, and the stored form does not contain the token", () => {
    const enc = encryptToken("SECRET-TOKEN", KEY);
    expect(enc).not.toMatch(/SECRET-TOKEN/);
    expect(decryptToken(enc, KEY)).toBe("SECRET-TOKEN");
  });

  it("refuses the wrong key", () => {
    expect(() => decryptToken(encryptToken("x", KEY), randomBytes(32))).toThrow();
  });

  it("wants a 32-byte base64 key", () => {
    expect(parseTokenKey(KEY.toString("base64")).length).toBe(32);
    expect(() => parseTokenKey("short")).toThrow(/32 bytes/);
  });
});

describe("token provider", () => {
  it("uses the held access token while it is far from expiry, without refreshing", async () => {
    const { store } = memoryStore(held(20 * DAY));
    const fetchImpl = vi.fn();
    const p = createShipHeroTokenProvider({ store, fetchImpl, now: () => NOW });
    expect(await p.getAccessToken()).toBe("A1");
    expect(await p.getAccessToken()).toBe("A1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes once the token is near expiry, and stores the new refresh token ShipHero returned", async () => {
    const { store, current } = memoryStore(held(REFRESH_BEFORE_EXPIRY_MS - 1000));
    const fetchImpl = vi.fn().mockResolvedValue(tokenReply({ access_token: "A2", refresh_token: "R2", expires_in: 2419200, scope: GRANTED }));
    const p = createShipHeroTokenProvider({ store, fetchImpl, now: () => NOW });
    expect(await p.getAccessToken()).toBe("A2");
    expect(current()).toMatchObject({ accessToken: "A2", refreshToken: "R2", expiresAt: new Date(NOW.getTime() + 2419200 * 1000) });
  });

  it("keeps the old refresh token when ShipHero sends none", async () => {
    const { store, current } = memoryStore(held(1000));
    const fetchImpl = vi.fn().mockResolvedValue(tokenReply({ access_token: "A2", expires_in: 2419200 }));
    await createShipHeroTokenProvider({ store, fetchImpl, now: () => NOW }).getAccessToken();
    expect(current()).toMatchObject({ accessToken: "A2", refreshToken: "R1", scope: GRANTED });
  });

  // Another process may have refreshed while this one waited for the lock;
  // with rotating refresh tokens, refreshing again would spend a dead one.
  it("does not refresh again when the row it locked was already refreshed", async () => {
    const stale = held(1000);
    let row: StoredTokens = stale;
    const store: TokenStore = {
      load: async () => stale,
      withLock: async (fn) => {
        row = held(20 * DAY);
        row.accessToken = "FROM-OTHER";
        const out = await fn(row);
        return out.result;
      },
    };
    const fetchImpl = vi.fn();
    expect(await createShipHeroTokenProvider({ store, fetchImpl, now: () => NOW }).getAccessToken()).toBe("FROM-OTHER");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes on demand after a 401, whatever the expiry says", async () => {
    const { store } = memoryStore(held(20 * DAY));
    const fetchImpl = vi.fn().mockResolvedValue(tokenReply({ access_token: "A2", expires_in: 2419200, scope: GRANTED }));
    const p = createShipHeroTokenProvider({ store, fetchImpl, now: () => NOW });
    expect(await p.forceRefresh("A1")).toBe("A2");
  });

  // Fail closed: a refresh never widens what the token may do.
  it("refuses a refreshed token whose scope is not what was granted, and keeps nothing", async () => {
    const { store, saved } = memoryStore(held(1000));
    const fetchImpl = vi.fn().mockResolvedValue(tokenReply({ access_token: "A2", expires_in: 2419200, scope: `${GRANTED} view:pii` }));
    await expect(createShipHeroTokenProvider({ store, fetchImpl, now: () => NOW }).getAccessToken()).rejects.toThrow(/view:pii/);
    expect(saved).toEqual([]);
  });

  it("says ShipHero is not signed in when no token is stored", async () => {
    const { store } = memoryStore(null);
    await expect(createShipHeroTokenProvider({ store, fetchImpl: vi.fn(), now: () => NOW }).getAccessToken()).rejects.toBeInstanceOf(ShipHeroNotAuthorisedError);
  });
});
