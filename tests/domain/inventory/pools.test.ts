/**
 * ─── Shared inventory pools (#9) ──────────────────────────────────────
 *
 * Several products sell the same physical stock through quantity-break
 * variants. Shopify holds a separate inventory item per variant — verified:
 * `BAGHLLWN2023` appears twice with two different `inventory_item_id`s — so
 * nothing in Shopify keeps them consistent. A Mechanic task used to.
 *
 * A pack variant's `quantity` is **how many N-packs can be made**, not how
 * many units are held. Against production:
 *
 *   Spooky Spells / 1    796 x  1 = 796
 *   Spooky Spells / 2    398 x  2 = 796
 *   Spooky Spells / 5    159 x  5 = 795
 *   Spooky Spells / 25    31 x 25 = 775
 *
 * They agree. The spread is integer division — 796/25 truncates to 31 — and
 * summing the rows gives 3,049, which is a quantity of nothing. #9 reported
 * that sum as evidence of drift; it is an artefact of adding different units.
 *
 * So the number is already right and the alarm is what is missing: the day the
 * pools stop agreeing is the day oversell becomes real, and today it would
 * pass unremarked.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  impliedPoolUnits,
  parsePoolDeclaration,
  assessPool,
  findUndeclaredPoolCandidates,
  type PoolVariant,
} from "@/domain/inventory/pools";

const variant = (over: Partial<PoolVariant> = {}): PoolVariant => ({
  variantId: `gid://v/${Math.random()}`,
  sku: "BAGHLLWN2023",
  variantTitle: "Spooky Spells / 1",
  packSize: 1,
  quantity: 796,
  productStatus: "UNLISTED",
  unitsSoldLast30d: 0,
  ...over,
});

describe("impliedPoolUnits", () => {
  it("multiplies packs held by pack size", () => {
    expect(impliedPoolUnits(variant({ quantity: 398, packSize: 2 }))).toBe(796);
  });

  it("reads a single unit as itself", () => {
    expect(impliedPoolUnits(variant({ quantity: 796, packSize: 1 }))).toBe(796);
  });

  /**
   * A pack size of zero would make every pool read as empty, and a negative
   * one would make stock read as negative. Neither is a quantity — the variant
   * is malformed and has to be excluded rather than multiplied.
   */
  it("refuses a pack size that cannot be a pack size", () => {
    expect(() => impliedPoolUnits(variant({ packSize: 0 }))).toThrow(
      "Pack size must be a positive whole number, got 0"
    );
    expect(() => impliedPoolUnits(variant({ packSize: -3 }))).toThrow(
      "Pack size must be a positive whole number, got -3"
    );
  });
});

describe("assessPool: agreement and the rounding that is not disagreement", () => {
  /** The live Spooky Spells group, exactly as production holds it. */
  const spookySpells: PoolVariant[] = [
    variant({ sku: "BAGHLLWN2023", packSize: 1, quantity: 796 }),
    variant({ sku: "BAGHLLWN2023P2", packSize: 2, quantity: 398 }),
    variant({ sku: "BAGHLLWN2023P3", packSize: 3, quantity: 265 }),
    variant({ sku: "BAGHLLWN2023P4", packSize: 4, quantity: 199 }),
    variant({ sku: "BAGHLLWN2023P5", packSize: 5, quantity: 159 }),
    variant({ sku: "BAGHLLWN2023P10", packSize: 10, quantity: 79 }),
    variant({ sku: "BAGHLLWN2023P25", packSize: 25, quantity: 31 }),
  ];

  it("reports the pool as the largest implied figure", () => {
    // The 1-pack is the only member that cannot lose units to truncation.
    expect(assessPool("Spooky Spells", spookySpells).poolUnits).toBe(796);
  });

  /**
   * The raw spread here is 21 units (796 down to 775), and every one of them
   * is truncation: 796/25 = 31.84 packs, and a third of a pack is not stock.
   * Reporting that as drift would cry wolf on a correctly synced group, which
   * is how an alarm gets ignored.
   */
  it("calls a fully rounded spread agreement, not drift", () => {
    const r = assessPool("Spooky Spells", spookySpells);
    expect(r.diverged).toBe(false);
    expect(r.worstDriftUnits).toBe(0);
  });

  it("still reports the raw spread, so the rounding is visible rather than hidden", () => {
    expect(assessPool("Spooky Spells", spookySpells).rawSpreadUnits).toBe(21);
  });

  /**
   * One unit beyond what truncation can explain is drift. The threshold is
   * not a tolerance to tune — it is arithmetic, and anything above it means
   * a variant was decremented while its siblings were not.
   */
  it("flags a single unit of real drift", () => {
    const drifted = spookySpells.map((v) =>
      v.packSize === 2 ? { ...v, quantity: 397 } : v
    );
    const r = assessPool("Spooky Spells", drifted);
    expect(r.diverged).toBe(true);
    // 397 x 2 = 794, two short of 796. A 2-pack can truncate away one unit —
    // a pool of 795 also floors to 397 packs — so exactly one unit is drift.
    expect(r.worstDriftUnits).toBe(1);
  });

  it("names which variant drifted, not merely that one did", () => {
    const drifted = spookySpells.map((v) =>
      v.packSize === 5 ? { ...v, quantity: 150 } : v
    );
    const r = assessPool("Spooky Spells", drifted);
    expect(r.diverged).toBe(true);
    expect(r.worst?.sku).toBe("BAGHLLWN2023P5");
  });

  /**
   * Drift is always a shortfall against the best-informed member, so the units
   * at risk are units the storefront believes it has and does not. That is the
   * number an operator acts on.
   */
  it("reports drift as units, not as a percentage", () => {
    const drifted = spookySpells.map((v) =>
      v.packSize === 1 ? { ...v, quantity: 700 } : v
    );
    const r = assessPool("Spooky Spells", drifted);
    expect(r.poolUnits).toBe(796);
    expect(r.worstDriftUnits).toBe(96);
    expect(r.worst?.sku).toBe("BAGHLLWN2023");
  });

  // A group nobody can compare is not a group in agreement.
  it("cannot assess a group with one member, and says so", () => {
    const r = assessPool("Solo", [variant()]);
    expect(r.diverged).toBeNull();
    expect(r.reason).toMatch(/one member/i);
  });

  it("cannot assess an empty group", () => {
    const r = assessPool("Gone", []);
    expect(r.diverged).toBeNull();
    expect(r.poolUnits).toBeNull();
    expect(r.reason).toMatch(/no variants/i);
  });

  /**
   * #9's real exposure: these variants sell and every one of them classifies
   * `ignored`, because `classifyItem` ignores anything not ACTIVE and the
   * whole quantity-break product is UNLISTED. Stock is moving and nothing is
   * watching it.
   */
  it("counts sales the ordinary checks ignore", () => {
    const selling = spookySpells.map((v) =>
      v.packSize === 2 ? { ...v, unitsSoldLast30d: 4 } : v
    );
    const r = assessPool("Spooky Spells", selling);
    // Four 2-packs is eight units out of the shared pool.
    expect(r.unitsSoldLast30d).toBe(8);
    expect(r.monitoredByOrdinaryChecks).toBe(false);
  });

  it("says when a group IS covered by the ordinary checks", () => {
    const active = spookySpells.map((v) => ({ ...v, productStatus: "ACTIVE" }));
    expect(assessPool("Spooky Spells", active).monitoredByOrdinaryChecks).toBe(true);
  });
});

/**
 * ─── Finding groups nobody declared ───────────────────────────────────
 *
 * #9 asks for grouping to be "recorded as explicit grouping data rather than
 * inferred from a title regex — the grouping is a fact about fulfilment, not
 * about naming, and a title convention will drift."
 *
 * So the declaration is the source of truth and the regex is only a way to
 * surface candidates for a human to confirm. That distinction is the whole
 * design: an inferred group is never silently treated as declared.
 */
describe("findUndeclaredPoolCandidates", () => {
  const rows = [
    { variantId: "1", sku: "NEWPROD", variantTitle: "Design A / 1", quantity: 100, productStatus: "ACTIVE", unitsSoldLast30d: 0 },
    { variantId: "2", sku: "NEWPRODP2", variantTitle: "Design A / 2", quantity: 50, productStatus: "ACTIVE", unitsSoldLast30d: 0 },
    { variantId: "3", sku: "PLAIN", variantTitle: "Default Title", quantity: 10, productStatus: "ACTIVE", unitsSoldLast30d: 0 },
  ];

  it("spots a quantity-break product that is not declared", () => {
    const found = findUndeclaredPoolCandidates(rows, []);
    expect(found).toHaveLength(1);
    expect(found[0].groupKey).toBe("Design A");
    expect(found[0].skus).toEqual(["NEWPROD", "NEWPRODP2"]);
  });

  it("stays quiet about a group that is already declared", () => {
    expect(findUndeclaredPoolCandidates(rows, ["Design A"])).toEqual([]);
  });

  // One variant with a slash in its name is a name, not a pool.
  it("does not invent a group from a single variant", () => {
    const single = [rows[0], rows[2]];
    expect(findUndeclaredPoolCandidates(single, [])).toEqual([]);
  });

  it("ignores variants with no pack suffix at all", () => {
    const found = findUndeclaredPoolCandidates(rows, []);
    expect(found[0].skus).not.toContain("PLAIN");
  });
});

/**
 * ─── The declaration is checked, not trusted ──────────────────────────
 *
 * A malformed pool produces a pool figure that looks computed, which is worse
 * than no figure. Load time is the only point where a person is present.
 */
describe("parsePoolDeclaration", () => {
  const pool = (over: Record<string, unknown> = {}) => ({
    groupKey: "Spooky Spells",
    productTitle: "Reusable Trick or Treat Bag",
    variants: [
      { sku: "A", packSize: 1 },
      { sku: "B", packSize: 2 },
    ],
    ...over,
  });

  it("reads a valid declaration", () => {
    const pools = parsePoolDeclaration({ pools: [pool()] });
    expect(pools).toHaveLength(1);
    expect(pools[0].variants).toHaveLength(2);
  });

  it("rejects a file with no pools array", () => {
    expect(() => parsePoolDeclaration({})).toThrow("Pool declaration has no `pools` array");
  });

  // A pool of one cannot disagree with itself.
  it("rejects a pool with fewer than two variants", () => {
    expect(() =>
      parsePoolDeclaration({ pools: [pool({ variants: [{ sku: "A", packSize: 1 }] })] })
    ).toThrow("Pool Spooky Spells needs at least two variants");
  });

  it("rejects a pack size that is not a pack size", () => {
    expect(() =>
      parsePoolDeclaration({
        pools: [pool({ variants: [{ sku: "A", packSize: 1 }, { sku: "B", packSize: 0 }] })],
      })
    ).toThrow("Pool Spooky Spells, sku B: pack size must be a positive whole number, got 0");
  });

  /**
   * One SKU in two pools means one of them is wrong, and the drift that
   * produces reads as a stock problem rather than a configuration one — the
   * most expensive kind of wrong answer to chase.
   */
  it("rejects a SKU claimed by two pools", () => {
    expect(() =>
      parsePoolDeclaration({
        pools: [pool(), pool({ groupKey: "Ghostly Goodies" })],
      })
    ).toThrow("SKU A is declared in more than one pool");
  });

  it("rejects the same pool declared twice", () => {
    expect(() =>
      parsePoolDeclaration({
        pools: [
          pool(),
          pool({ variants: [{ sku: "C", packSize: 1 }, { sku: "D", packSize: 2 }] }),
        ],
      })
    ).toThrow("Pool declared twice: Spooky Spells");
  });
});

/**
 * The shipped declaration has to describe the real catalogue.
 *
 * A declaration that parses but names SKUs nobody sells is a configuration
 * nobody is checking — the same shape as a test that never runs.
 */
describe("the shipped pool declaration", () => {
  const declaration = parsePoolDeclaration(
    JSON.parse(
      readFileSync(join(process.cwd(), "src/domain/inventory/inventory-pools.json"), "utf-8")
    )
  );

  it("declares the two Halloween pools", () => {
    expect(declaration.map((p) => p.groupKey).sort()).toEqual([
      "Ghostly Goodies",
      "Spooky Spells",
    ]);
  });

  it("declares every pack size the live product sells", () => {
    const spooky = declaration.find((p) => p.groupKey === "Spooky Spells")!;
    expect(spooky.variants.map((v) => v.packSize)).toEqual([1, 2, 3, 4, 5, 10, 25]);
  });

  // The pack size has to match the SKU suffix, or the pool arithmetic is wrong
  // in a way that produces a plausible number.
  it("keeps every pack size consistent with its SKU suffix", () => {
    for (const p of declaration) {
      for (const v of p.variants) {
        const suffix = v.sku.match(/P(\d+)$/);
        const expected = suffix ? Number(suffix[1]) : 1;
        expect(v.packSize, `${v.sku} declares packSize ${v.packSize}`).toBe(expected);
      }
    }
  });
});

/**
 * ─── One SKU, two inventory items ─────────────────────────────────────
 *
 * 17 SKUs in this catalogue belong to more than one variant. `BAGHLLWN2023`
 * is an ACTIVE "Default Title" product AND an UNLISTED "Spooky Spells / 1"
 * variant — two separate Shopify inventory items holding the same bags, with
 * two different `inventory_item_id`s.
 *
 * Found by running the tool against production: a `Map` keyed on SKU kept one
 * of them, and the pool reported `monitoredByOrdinaryChecks: false` although
 * one member is ACTIVE and very much monitored. Those two items diverging is
 * the exact failure this module exists to catch, so both have to be members.
 */
describe("a SKU held by two inventory items", () => {
  const twins: PoolVariant[] = [
    variant({ variantId: "v1", sku: "BAGHLLWN2023", variantTitle: "Default Title", productStatus: "ACTIVE", packSize: 1, quantity: 796 }),
    variant({ variantId: "v2", sku: "BAGHLLWN2023", variantTitle: "Spooky Spells / 1", productStatus: "UNLISTED", packSize: 1, quantity: 796 }),
  ];

  it("keeps both as members rather than collapsing them", () => {
    const r = assessPool("Spooky Spells", twins);
    expect(r.members).toHaveLength(2);
    expect(r.members.map((m) => m.productStatus).sort()).toEqual(["ACTIVE", "UNLISTED"]);
  });

  it("is monitored when either item is ACTIVE", () => {
    expect(assessPool("Spooky Spells", twins).monitoredByOrdinaryChecks).toBe(true);
  });

  /**
   * The case that matters. Nothing decrements both, so the day one sells the
   * other still claims the stock — and 796 phantom bags is exactly the
   * oversell #9 was filed about.
   */
  it("catches the two items drifting apart", () => {
    const drifted = [twins[0], { ...twins[1], quantity: 700 }];
    const r = assessPool("Spooky Spells", drifted);
    expect(r.diverged).toBe(true);
    expect(r.worstDriftUnits).toBe(96);
  });
});
