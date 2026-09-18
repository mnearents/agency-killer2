/**
 * `inventory_pools` at its call site.
 *
 * The assessment is covered in `tests/domain/inventory/pools.test.ts`. What is
 * asserted here is the wiring: that the tool is registered, that it reads the
 * catalogue WITHOUT the ACTIVE filter that makes these variants invisible in
 * the first place, and that a SKU held by two inventory items produces two
 * members rather than one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ALL_TOOLS, dispatchTool, type McpToolContext } from "@/mcp/tools";
import * as inventoryQueries from "@/domain/inventory/queries";

vi.mock("@/domain/inventory/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domain/inventory/queries")>();
  return { ...actual, getInventoryItems: vi.fn(), getPoolVariantRows: vi.fn() };
});

const NOW = new Date("2026-09-18T12:00:00Z");
const ctx = { db: {} as never, now: () => NOW } as unknown as McpToolContext;

const row = (over: Record<string, unknown> = {}) => ({
  variantId: `gid://v/${Math.random()}`,
  sku: "BAGHLLWN2023",
  variantTitle: "Spooky Spells / 1",
  quantity: 796,
  productStatus: "UNLISTED",
  unitsSoldLast30d: 0,
  ...over,
});

/** The live Spooky Spells pool, as production holds it. */
const SPOOKY = [
  row({ sku: "BAGHLLWN2023", variantTitle: "Default Title", productStatus: "ACTIVE", quantity: 796 }),
  row({ sku: "BAGHLLWN2023", quantity: 796 }),
  row({ sku: "BAGHLLWN2023P2", variantTitle: "Spooky Spells / 2", quantity: 398 }),
  row({ sku: "BAGHLLWN2023P3", variantTitle: "Spooky Spells / 3", quantity: 265 }),
  row({ sku: "BAGHLLWN2023P4", variantTitle: "Spooky Spells / 4", quantity: 199 }),
  row({ sku: "BAGHLLWN2023P5", variantTitle: "Spooky Spells / 5", quantity: 159 }),
  row({ sku: "BAGHLLWN2023P10", variantTitle: "Spooky Spells / 10", quantity: 79 }),
  row({ sku: "BAGHLLWN2023P25", variantTitle: "Spooky Spells / 25", quantity: 31 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inventoryQueries.getPoolVariantRows).mockResolvedValue(SPOOKY as never);
});

type PoolsResult = {
  pools: Array<{
    group: string;
    poolUnits: number | null;
    diverged: boolean | null;
    driftUnits: number;
    rawSpreadUnits: number;
    monitoredByOrdinaryChecks: boolean;
    members: Array<{ sku: string; productStatus: string; impliedUnits: number }>;
    declaredButNotInCatalogue?: string[];
  }>;
  undeclaredCandidates: Array<{ groupKey: string }>;
};

describe("inventory_pools is reachable", () => {
  it("is in the tool list", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toContain("inventory_pools");
  });
});

describe("inventory_pools", () => {
  it("reports the pool as units, never as the sum of the rows", async () => {
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    const spooky = r.pools.find((p) => p.group === "Spooky Spells")!;
    expect(spooky.poolUnits).toBe(796);
    // Adding the packs held would give 2,723 — a quantity of nothing.
    expect(spooky.diverged).toBe(false);
  });

  /**
   * `BAGHLLWN2023` is an ACTIVE "Default Title" product AND an UNLISTED
   * "Spooky Spells / 1" variant — two Shopify inventory items over the same
   * bags. Keying on SKU dropped one, and the pool then reported itself
   * unmonitored although one member is ACTIVE. Found against production.
   */
  it("keeps both inventory items that share a SKU", async () => {
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    const spooky = r.pools.find((p) => p.group === "Spooky Spells")!;
    const twins = spooky.members.filter((m) => m.sku === "BAGHLLWN2023");
    expect(twins).toHaveLength(2);
    expect(twins.map((m) => m.productStatus).sort()).toEqual(["ACTIVE", "UNLISTED"]);
    expect(spooky.monitoredByOrdinaryChecks).toBe(true);
  });

  /**
   * The ordinary checks ignore everything that is not ACTIVE, which is why
   * these variants were never monitored. Reading the catalogue through the
   * same filter would reproduce the blind spot this tool exists to remove.
   */
  it("reads the catalogue without the ACTIVE filter", async () => {
    await dispatchTool(ctx, "inventory_pools", {});
    expect(inventoryQueries.getPoolVariantRows).toHaveBeenCalled();
    expect(inventoryQueries.getInventoryItems).not.toHaveBeenCalled();
  });

  // Integer division alone produces a spread; only drift is disagreement.
  it("separates the rounding spread from real drift", async () => {
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    const spooky = r.pools.find((p) => p.group === "Spooky Spells")!;
    expect(spooky.rawSpreadUnits).toBe(21);
    expect(spooky.driftUnits).toBe(0);
  });

  it("raises drift when a member falls out of step", async () => {
    vi.mocked(inventoryQueries.getPoolVariantRows).mockResolvedValue(
      SPOOKY.map((v) => (v.sku === "BAGHLLWN2023P2" ? { ...v, quantity: 300 } : v)) as never
    );
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    const spooky = r.pools.find((p) => p.group === "Spooky Spells")!;
    expect(spooky.diverged).toBe(true);
    // 300 x 2 = 600, and a 2-pack can truncate away only one unit.
    expect(spooky.driftUnits).toBe(195);
  });

  /**
   * A declared SKU the catalogue no longer has is a stale declaration, not an
   * empty pool. Dropping it silently shrinks the pool and changes the answer.
   */
  it("names declared SKUs that are no longer in the catalogue", async () => {
    vi.mocked(inventoryQueries.getPoolVariantRows).mockResolvedValue(
      SPOOKY.filter((v) => v.sku !== "BAGHLLWN2023P25") as never
    );
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    const spooky = r.pools.find((p) => p.group === "Spooky Spells")!;
    expect(spooky.declaredButNotInCatalogue).toEqual(["BAGHLLWN2023P25"]);
  });

  it("surfaces an undeclared quantity-break product", async () => {
    vi.mocked(inventoryQueries.getPoolVariantRows).mockResolvedValue([
      ...SPOOKY,
      row({ sku: "NEWTHING", variantTitle: "Brand New / 1", productStatus: "ACTIVE" }),
      row({ sku: "NEWTHINGP2", variantTitle: "Brand New / 2", productStatus: "ACTIVE" }),
    ] as never);
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    expect(r.undeclaredCandidates.map((c) => c.groupKey)).toContain("Brand New");
  });

  // Declared groups are not candidates; a declaration that kept nagging would
  // be one nobody reads.
  it("does not report a declared pool as a candidate", async () => {
    const r = (await dispatchTool(ctx, "inventory_pools", {})) as PoolsResult;
    expect(r.undeclaredCandidates.map((c) => c.groupKey)).not.toContain("Spooky Spells");
  });

  it("warns in its own description against summing the rows", () => {
    const tool = ALL_TOOLS.find((t) => t.name === "inventory_pools")!;
    expect(tool.description).toMatch(/NEVER sum quantity across a pool/);
  });
});
