/**
 * Shared inventory pools — quantity-break variants of one physical stock (#9).
 *
 * Several products sell the same bags through "1 pack / 2 pack / 25 pack"
 * variants. Shopify holds a **separate inventory item per variant** — verified
 * against production, where `BAGHLLWN2023` appears twice under two different
 * `inventory_item_id`s — so nothing in Shopify keeps them consistent. A
 * Mechanic task used to, and it was uninstalled.
 *
 * ## The unit trap
 *
 * A pack variant's `quantity` is **how many N-packs can be made**, not how
 * many units are held:
 *
 *     Spooky Spells / 1    796 x  1 = 796
 *     Spooky Spells / 2    398 x  2 = 796
 *     Spooky Spells / 5    159 x  5 = 795
 *     Spooky Spells / 25    31 x 25 = 775
 *
 * Every member implies the same pool. Adding the rows gives 3,049, which is a
 * quantity of nothing — #9 reported that sum as evidence of drift and it is an
 * artefact of adding different units. The 21-unit spread is integer division:
 * 796/25 is 31.84 packs, and a third of a pack is not stock.
 *
 * ## So the number is right and the alarm is missing
 *
 * 74 units have sold across five pack sizes since these were last checked, and
 * the seven variants still agree, so something is keeping them in step today.
 * The day it stops is the day oversell becomes real, and nothing would notice:
 * every one of these variants is UNLISTED, and `classifyItem` returns
 * `ignored` for anything that is not ACTIVE. Stock is moving and no check is
 * watching it.
 *
 * Pure functions only — no database, no clock.
 */

/** A variant that belongs to a declared pool. */
export interface PoolVariant {
  variantId: string;
  sku: string;
  variantTitle: string;
  /** Units per pack. 1 for a single. */
  packSize: number;
  /** Packs held, NOT units. This is the whole trap. */
  quantity: number;
  productStatus: string;
  unitsSoldLast30d: number;
}

/**
 * Units of shared stock this variant's count implies.
 *
 * Throws rather than returning 0 on a malformed pack size: a pack of zero
 * would make every pool read empty and a negative one would make stock read
 * negative, and both are numbers someone could act on.
 */
export function impliedPoolUnits(variant: PoolVariant): number {
  if (!Number.isInteger(variant.packSize) || variant.packSize < 1) {
    throw new Error(
      `Pack size must be a positive whole number, got ${variant.packSize}`
    );
  }
  return variant.quantity * variant.packSize;
}

export interface PoolMember {
  sku: string;
  variantTitle: string;
  /** Carried through so a member invisible to `classifyItem` is identifiable. */
  productStatus: string;
  packSize: number;
  quantity: number;
  impliedUnits: number;
  /** Units below the pool that truncation cannot explain. Zero when in step. */
  driftUnits: number;
}

export interface PoolAssessment {
  groupKey: string;
  /** Null when there is nothing to measure. Never 0, which would read as empty. */
  poolUnits: number | null;
  members: PoolMember[];
  /** Null when the group cannot be assessed at all. */
  diverged: boolean | null;
  /** The largest shortfall truncation cannot explain. */
  worstDriftUnits: number;
  /** Which member is furthest out of step. */
  worst: PoolMember | null;
  /** Raw high-minus-low, reported so the rounding is visible rather than hidden. */
  rawSpreadUnits: number;
  /** Units out of the shared pool in the last 30 days, across every pack size. */
  unitsSoldLast30d: number;
  /** False when every member is invisible to `classifyItem` — the #9 exposure. */
  monitoredByOrdinaryChecks: boolean;
  reason?: string;
}

/**
 * Whether a pool's members still agree.
 *
 * The pool is the LARGEST implied figure, because truncation can only ever
 * lose units: a 25-pack variant holding 31 packs of an 796-unit pool is
 * reporting 775 and is not missing 21 bags. So drift is measured as a
 * shortfall against the best-informed member, and a member is in step when its
 * shortfall is within what its own pack size could truncate away.
 *
 * That threshold is arithmetic rather than a tolerance to tune, which matters:
 * a tuned tolerance on a correctly synced group cries wolf, and an alarm that
 * cries wolf is one nobody reads.
 */
export function assessPool(groupKey: string, variants: PoolVariant[]): PoolAssessment {
  const empty = {
    groupKey,
    poolUnits: null,
    members: [],
    diverged: null,
    worstDriftUnits: 0,
    worst: null,
    rawSpreadUnits: 0,
    unitsSoldLast30d: 0,
    monitoredByOrdinaryChecks: false,
  };

  if (variants.length === 0) {
    return { ...empty, reason: "No variants in this pool, so nothing was compared." };
  }

  const implied = variants.map((v) => ({ v, units: impliedPoolUnits(v) }));
  const poolUnits = Math.max(...implied.map((i) => i.units));
  const lowest = Math.min(...implied.map((i) => i.units));

  const members: PoolMember[] = implied.map(({ v, units }) => {
    // Truncation can hide at most packSize - 1 units on this member.
    const explainable = v.packSize - 1;
    const shortfall = poolUnits - units;
    return {
      sku: v.sku,
      variantTitle: v.variantTitle,
      productStatus: v.productStatus,
      packSize: v.packSize,
      quantity: v.quantity,
      impliedUnits: units,
      driftUnits: Math.max(0, shortfall - explainable),
    };
  });

  const unitsSoldLast30d = variants.reduce(
    // Sales are in packs too, so a 2-pack sale is two units out of the pool.
    (sum, v) => sum + v.unitsSoldLast30d * v.packSize,
    0
  );
  const monitoredByOrdinaryChecks = variants.some((v) => v.productStatus === "ACTIVE");

  if (variants.length === 1) {
    return {
      ...empty,
      poolUnits,
      members,
      unitsSoldLast30d,
      monitoredByOrdinaryChecks,
      reason:
        "This pool has one member, so there is nothing to compare it against. " +
        "Agreement is a statement about two or more counts.",
    };
  }

  const worst = members.reduce((a, b) => (b.driftUnits > a.driftUnits ? b : a));

  return {
    groupKey,
    poolUnits,
    members,
    diverged: worst.driftUnits > 0,
    worstDriftUnits: worst.driftUnits,
    worst: worst.driftUnits > 0 ? worst : null,
    rawSpreadUnits: poolUnits - lowest,
    unitsSoldLast30d,
    monitoredByOrdinaryChecks,
  };
}

/** A variant as the inventory query returns it, before any pool is known. */
export interface CandidateRow {
  variantId: string;
  sku: string;
  variantTitle: string | null;
  quantity: number;
  productStatus: string;
  unitsSoldLast30d: number;
}

export interface PoolCandidate {
  groupKey: string;
  skus: string[];
  variantTitles: string[];
}

/** "Spooky Spells / 25" -> { design: "Spooky Spells", packSize: 25 } */
const PACK_TITLE = /^(.*?)\s*\/\s*(\d+)\s*$/;

export function parsePackTitle(
  variantTitle: string | null
): { design: string; packSize: number } | null {
  const m = variantTitle?.match(PACK_TITLE);
  if (!m) return null;
  const packSize = Number(m[2]);
  if (!Number.isInteger(packSize) || packSize < 1) return null;
  return { design: m[1].trim(), packSize };
}

/**
 * Quantity-break products that no declaration covers.
 *
 * #9: the grouping should be "recorded as explicit grouping data rather than
 * inferred from a title regex — the grouping is a fact about fulfilment, not
 * about naming, and a title convention will drift."
 *
 * That is why this returns CANDIDATES. The declaration is the source of truth;
 * this only surfaces a product that looks like a pool so a human can confirm
 * it, and an inferred group is never treated as a declared one. Without it a
 * new quantity-break product joins the catalogue unnoticed, which is how this
 * one went unnoticed.
 */
export function findUndeclaredPoolCandidates(
  rows: CandidateRow[],
  declaredGroupKeys: string[]
): PoolCandidate[] {
  const declared = new Set(declaredGroupKeys);
  const byDesign = new Map<string, CandidateRow[]>();

  for (const row of rows) {
    const parsed = parsePackTitle(row.variantTitle);
    if (!parsed) continue;
    const list = byDesign.get(parsed.design);
    if (list) list.push(row);
    else byDesign.set(parsed.design, [row]);
  }

  const candidates: PoolCandidate[] = [];
  for (const [design, members] of byDesign) {
    // One variant with a slash in its name is a name, not a pool.
    if (members.length < 2) continue;
    if (declared.has(design)) continue;
    candidates.push({
      groupKey: design,
      skus: members.map((m) => m.sku),
      variantTitles: members.map((m) => m.variantTitle ?? ""),
    });
  }

  return candidates;
}

/**
 * ─── The declaration ──────────────────────────────────────────────────
 */

export interface DeclaredPoolVariant {
  sku: string;
  packSize: number;
}

export interface DeclaredPool {
  groupKey: string;
  productTitle: string;
  note?: string;
  variants: DeclaredPoolVariant[];
}

/**
 * Read the declaration, checking it rather than trusting it.
 *
 * A pool declared with a duplicate SKU, or with a pack size that is not a pack
 * size, would produce a pool figure that looks computed. Throwing at load is
 * the only point where a person is present to fix it.
 */
export function parsePoolDeclaration(raw: unknown): DeclaredPool[] {
  const pools = (raw as { pools?: unknown })?.pools;
  if (!Array.isArray(pools)) {
    throw new Error("Pool declaration has no `pools` array");
  }

  const seenGroups = new Set<string>();
  const seenSkus = new Set<string>();

  return pools.map((p, i) => {
    const pool = p as Partial<DeclaredPool>;
    if (!pool.groupKey) throw new Error(`Pool ${i} has no groupKey`);
    if (seenGroups.has(pool.groupKey)) {
      throw new Error(`Pool declared twice: ${pool.groupKey}`);
    }
    seenGroups.add(pool.groupKey);

    if (!Array.isArray(pool.variants) || pool.variants.length < 2) {
      // A pool of one cannot disagree with itself, so declaring one is a
      // mistake rather than a configuration.
      throw new Error(`Pool ${pool.groupKey} needs at least two variants`);
    }

    for (const v of pool.variants) {
      if (!v.sku) throw new Error(`Pool ${pool.groupKey} has a variant with no sku`);
      if (!Number.isInteger(v.packSize) || v.packSize < 1) {
        throw new Error(
          `Pool ${pool.groupKey}, sku ${v.sku}: pack size must be a positive whole number, got ${v.packSize}`
        );
      }
      // One SKU in two pools means one of them is wrong, and the drift it
      // produces would look like a stock problem rather than a config one.
      if (seenSkus.has(v.sku)) {
        throw new Error(`SKU ${v.sku} is declared in more than one pool`);
      }
      seenSkus.add(v.sku);
    }

    return {
      groupKey: pool.groupKey,
      productTitle: pool.productTitle ?? "",
      note: pool.note,
      variants: pool.variants,
    };
  });
}
