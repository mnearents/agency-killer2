import { describe, it, expect, vi } from "vitest";
import { syncInventory, type InventorySyncDeps } from "@/domain/inventory/sync";
import { createMockShopifyApiClient } from "../../mocks/shopify-api";

/** A db that accepts every write and prunes nothing. */
function stubDb() {
  return {
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
  } as unknown as InventorySyncDeps["db"];
}

const depsReturning = (variants: unknown[]): InventorySyncDeps => ({
  client: createMockShopifyApiClient({
    getInventory: vi.fn().mockResolvedValue(variants),
  }),
  db: stubDb(),
});


/**
 * ─── Cost coverage is reported, not left to be discovered (#34) ───────
 *
 * Every cost-of-delivery figure is a guess until "Cost per item" is populated,
 * and the issue asks for coverage to be reported rather than assumed. A number
 * nobody prints is a number nobody acts on.
 *
 * The split matters more than the total. Against the live catalogue, 42 of 232
 * active variants carry a cost — 18%, which sounds alarming and is not, because
 * 181 of them are digital products, gift cards, subscriptions and classes that
 * correctly cost nothing. Among PHYSICAL variants it is 42 of 51, or 82%.
 *
 * So the result reports both populations and never a single blended figure.
 */
describe("syncInventory: cost coverage", () => {
  const variant = (over: Record<string, unknown> = {}) => ({
    id: `gid://shopify/ProductVariant/${Math.random()}`,
    title: "Default",
    sku: "S",
    inventoryQuantity: 1,
    price: "45.00",
    inventoryItem: { id: "i", tracked: true, unitCost: null },
    product: { id: "p", title: "T", status: "ACTIVE", productType: "Planners" },
    ...over,
  });

  const withCost = (amount: string, productType = "Planners") =>
    variant({
      inventoryItem: { id: "i", tracked: true, unitCost: amount },
      product: { id: "p", title: "T", status: "ACTIVE", productType },
    });

  const withoutCost = (productType = "Planners") =>
    variant({ product: { id: "p", title: "T", status: "ACTIVE", productType } });

  it("counts how many variants carry a cost at all", async () => {
    const result = await syncInventory(
      depsReturning([withCost("12.50"), withoutCost(), withoutCost()])
    );
    expect(result.cost.withCost).toBe(1);
    expect(result.cost.total).toBe(3);
  });

  /**
   * A digital product costing nothing is an answer. A planner with nothing
   * entered is a gap. Reporting one number over both populations describes
   * neither.
   */
  it("reports the physical population separately from the zero-COGS one", async () => {
    const result = await syncInventory(
      depsReturning([
        withCost("12.50", "Planners"),
        withoutCost("Planners"),
        withoutCost("Digital"),
        withoutCost("Subscription"),
      ])
    );
    expect(result.cost.physicalTotal).toBe(2);
    expect(result.cost.physicalWithCost).toBe(1);
  });

  it("counts a genuine zero as a recorded cost, not a missing one", async () => {
    const result = await syncInventory(depsReturning([withCost("0.0", "Digital")]));
    expect(result.cost.withCost).toBe(1);
  });

  it("reports zero coverage as zero rather than omitting it", async () => {
    const result = await syncInventory(depsReturning([withoutCost(), withoutCost()]));
    expect(result.cost.withCost).toBe(0);
    expect(result.cost.physicalWithCost).toBe(0);
  });
});

/**
 * Coverage is over ACTIVE variants only.
 *
 * The first version of this counted everything Shopify returned and reported
 * 85/327 — 26% — while the same catalogue filtered to active products had
 * only 8 physical variants missing a cost. The difference is archived and
 * draft products, whose landed cost cannot affect any margin because nothing
 * can be sold.
 *
 * A coverage figure diluted by products nobody can buy reads as a data-quality
 * crisis and is noise. Found by running against the live store; no unit test
 * would have shown it, because the fixtures were all ACTIVE.
 */
describe("syncInventory: coverage counts only what can be sold", () => {
  const v = (status: string, unitCost: string | null, productType = "Planners") => ({
    id: `gid://shopify/ProductVariant/${Math.random()}`,
    title: "Default",
    sku: "S",
    inventoryQuantity: 1,
    price: "45.00",
    inventoryItem: { id: "i", tracked: true, unitCost },
    product: { id: "p", title: "T", status, productType },
  });

  it("ignores archived and draft variants", async () => {
    const result = await syncInventory(
      depsReturning([v("ACTIVE", "12.50"), v("ARCHIVED", null), v("DRAFT", null)])
    );
    expect(result.cost.physicalTotal).toBe(1);
    expect(result.cost.physicalWithCost).toBe(1);
    expect(result.cost.total).toBe(1);
  });

  it("does not report a gap created entirely by archived products", async () => {
    const result = await syncInventory(
      depsReturning([v("ACTIVE", "12.50"), ...Array.from({ length: 20 }, () => v("ARCHIVED", null))])
    );
    expect(result.cost.physicalWithCost).toBe(result.cost.physicalTotal);
  });

  // The rows are still stored — only the coverage metric is scoped.
  it("still syncs the archived rows themselves", async () => {
    const result = await syncInventory(depsReturning([v("ACTIVE", "12.50"), v("ARCHIVED", null)]));
    expect(result.variants).toBe(2);
  });
});
