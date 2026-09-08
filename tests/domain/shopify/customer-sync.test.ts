import { describe, it, expect, vi } from "vitest";
import { syncCustomers } from "@/domain/shopify/customer-sync";
import { createMockShopifyApiClient } from "../../mocks/shopify-api";
import type { ShopifyApiCustomerProfile } from "@/integrations/shopify-api";
import type { Db } from "@/db/client";

const PROFILE: ShopifyApiCustomerProfile = {
  id: "gid://shopify/Customer/1",
  email: "a@example.com",
  firstName: "A",
  lastName: "B",
  createdAt: "2025-01-01T00:00:00Z",
  numberOfOrders: "2",
  amountSpent: { amount: "40.00" },
  tags: [],
  emailMarketingConsent: { marketingState: "SUBSCRIBED" },
  defaultAddress: null,
};

function profiles(n: number): ShopifyApiCustomerProfile[] {
  return Array.from({ length: n }, (_, i) => ({
    ...PROFILE,
    id: `gid://shopify/Customer/${i + 1}`,
  }));
}

function createMockDb() {
  const inserted: unknown[] = [];
  const db = {
    _inserted: inserted,
    insert() {
      return {
        values(row: unknown) {
          return {
            onConflictDoUpdate() {
              inserted.push(row);
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return db as unknown as Db & { _inserted: unknown[] };
}

const createMockClient = createMockShopifyApiClient;

const ROLLUP_RESULT = { updated: 3, withOrders: 2, subscribers: 1 };

describe("syncCustomers", () => {
  it("upserts one row per customer profile", async () => {
    const db = createMockDb();
    const result = await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockResolvedValue(profiles(3)),
      }),
      db,
      rollup: vi.fn().mockResolvedValue(ROLLUP_RESULT),
    });

    expect(db._inserted).toHaveLength(3);
    expect(result.customers).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it("fetches every customer, not only enrollment holders", async () => {
    const client = createMockClient({
      getCustomerProfiles: vi.fn().mockResolvedValue(profiles(1)),
    });
    await syncCustomers({ client, db: createMockDb(), rollup: vi.fn().mockResolvedValue(ROLLUP_RESULT) });

    expect(client.getCustomerProfiles).toHaveBeenCalled();
    expect(client.getCustomersWithEnrollments).not.toHaveBeenCalled();
  });

  it("runs the rollup after the customers are written", async () => {
    const db = createMockDb();
    let insertedWhenRollupRan = -1;
    const rollup = vi.fn().mockImplementation(async () => {
      insertedWhenRollupRan = db._inserted.length;
      return ROLLUP_RESULT;
    });

    const result = await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockResolvedValue(profiles(3)),
      }),
      db,
      rollup,
    });

    expect(insertedWhenRollupRan).toBe(3);
    expect(result.rollup).toEqual(ROLLUP_RESULT);
  });

  // The recurring failure in this project is a success signal with no work
  // behind it. A rollup over a half-written customer table reports counts that
  // look authoritative and describe nothing.
  it("does not run the rollup when the fetch failed", async () => {
    const rollup = vi.fn();
    const result = await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockRejectedValue(new Error("Shopify API error (429): slow down")),
      }),
      db: createMockDb(),
      rollup,
    });

    expect(rollup).not.toHaveBeenCalled();
    expect(result.rollup).toBeNull();
    expect(result.customers).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("429");
  });

  // null is "did not run". Zero would read as "ran and found nothing".
  it("reports a null rollup rather than a zeroed one when it did not run", async () => {
    const result = await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockRejectedValue(new Error("boom")),
      }),
      db: createMockDb(),
      rollup: vi.fn(),
    });
    expect(result.rollup).toBeNull();
  });

  it("surfaces a rollup failure instead of reporting the sync clean", async () => {
    const result = await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockResolvedValue(profiles(2)),
      }),
      db: createMockDb(),
      rollup: vi.fn().mockRejectedValue(new Error("relation does not exist")),
    });

    expect(result.customers).toBe(2);
    expect(result.rollup).toBeNull();
    expect(result.errors.join(" ")).toContain("relation does not exist");
  });

  it("succeeds with no customers without claiming a rollup it skipped", async () => {
    const rollup = vi.fn().mockResolvedValue({ updated: 0, withOrders: 0, subscribers: 0 });
    const result = await syncCustomers({
      client: createMockClient({ getCustomerProfiles: vi.fn().mockResolvedValue([]) }),
      db: createMockDb(),
      rollup,
    });

    // An empty fetch is not a failure — it still rolls up, and reports zero.
    expect(result.customers).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.rollup).toEqual({ updated: 0, withOrders: 0, subscribers: 0 });
  });

  it("stamps every row with the same syncedAt", async () => {
    const db = createMockDb();
    await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockResolvedValue(profiles(3)),
      }),
      db,
      rollup: vi.fn().mockResolvedValue(ROLLUP_RESULT),
    });

    const stamps = new Set(
      (db._inserted as Array<{ syncedAt: Date }>).map((r) => r.syncedAt.getTime())
    );
    expect(stamps.size).toBe(1);
  });

  it("passes the sync's timestamp to the rollup so derivedAt matches", async () => {
    const db = createMockDb();
    const rollup = vi.fn().mockResolvedValue(ROLLUP_RESULT);
    await syncCustomers({
      client: createMockClient({
        getCustomerProfiles: vi.fn().mockResolvedValue(profiles(1)),
      }),
      db,
      rollup,
    });

    const [, derivedAt] = rollup.mock.calls[0];
    const [row] = db._inserted as Array<{ syncedAt: Date }>;
    expect(derivedAt).toEqual(row.syncedAt);
  });
});
