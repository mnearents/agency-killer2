/**
 * Tier changes reconstructed from Seal's per-subscription log.
 *
 * An upgrade edits the existing subscription in place: Seal adds the new item,
 * removes the old one, and keeps the same subscription ID. `order_placed`,
 * `status` and the current-state row look identical before and after, and our
 * own snapshots only start 2026-09-02. The log is the only record that a tier
 * ever moved.
 *
 * Every rule below was derived from the 35 distinct entry templates actually
 * present across 4,395 subscriptions, not from Seal's documentation.
 */

export type Tier = "spark" | "studio" | "unknown";

export interface SealLogEntry {
  content: string;
  created: string;
}

export type LogEntryKind =
  | { kind: "add"; tier: Tier }
  | { kind: "remove"; tier: Tier }
  | { kind: "price" }
  | { kind: "other" };

export interface TierTransition {
  at: string;
  from: Tier;
  to: Tier;
  /** Whether a price edit accompanied this change. False is the 14076883 bug. */
  priceChangeLogged: boolean;
}

export interface TierHistory {
  subscriptionId: string;
  initialTier: Tier;
  finalTier: Tier;
  transitions: TierTransition[];
  netDirection: "upgrade" | "downgrade" | "none";
  /** More than one transition — swapped back and forth, needs human eyes. */
  churn: boolean;
}

// Seal writes two phrasings for the same action depending on whether the edit
// came through the API or the admin UI.
const ADD_RE = /^Merchant added (?:item )?"(.+?)" to the subscription/;
const REMOVE_RE = /^Merchant removed (?:item )?"(.+?)" from the subscription/;
const PRICE_RE = /^(?:Merchant changed the price of item|Automatically changed price of) "/;

function tierOfProduct(title: string): Tier {
  if (/studio/i.test(title)) return "studio";
  if (/spark/i.test(title)) return "spark";
  // "Really Awesome Doodles" with no suffix is the pre-rename product. Guessing
  // a tier for it would be a fabricated answer; unknown is the true one.
  return "unknown";
}

export function classifyLogEntry(content: string): LogEntryKind {
  if (PRICE_RE.test(content)) return { kind: "price" };

  const add = ADD_RE.exec(content);
  if (add) return { kind: "add", tier: tierOfProduct(add[1]) };

  const remove = REMOVE_RE.exec(content);
  if (remove) return { kind: "remove", tier: tierOfProduct(remove[1]) };

  return { kind: "other" };
}

/**
 * Seal stamps the log in UTC despite omitting the zone — confirmed against 542
 * cancellations whose `cancelled_on` field matched the log stamp exactly, with
 * zero offset. Reading it as local time would shift month boundaries.
 */
function toUtcMillis(created: string): number {
  return Date.parse(created.replace(" ", "T") + "Z");
}

/** Studio outranks Spark so the brief both-items state during a swap is not a tier. */
function tierOfSet(counts: Map<Tier, number>): Tier {
  if ((counts.get("studio") ?? 0) > 0) return "studio";
  if ((counts.get("spark") ?? 0) > 0) return "spark";
  return "unknown";
}

/** A price edit belongs to a tier change only if it landed in the same edit. */
const PRICE_WINDOW_MS = 60_000;

export function parseTierHistory(subscriptionId: string, log: SealLogEntry[]): TierHistory {
  const events = log
    .map((entry) => ({ at: toUtcMillis(entry.created), ...classifyLogEntry(entry.content) }))
    .filter((ev) => !Number.isNaN(ev.at))
    // Seal returns the log newest-first; folding it in that order would report
    // every upgrade as a downgrade. Ties break on kind so that an add and a
    // remove sharing a second always fold in the order Seal performed them.
    .sort((a, b) => a.at - b.at || rank(a.kind) - rank(b.kind));

  const priceAt = events.filter((ev) => ev.kind === "price").map((ev) => ev.at);

  // Nothing states the starting item set. An item removed while absent must
  // have been present from the start, so a first pass collects those debts.
  const initial = new Map<Tier, number>();
  const probe = new Map<Tier, number>();
  for (const ev of events) {
    if (ev.kind === "add") probe.set(ev.tier, (probe.get(ev.tier) ?? 0) + 1);
    else if (ev.kind === "remove") {
      const held = probe.get(ev.tier) ?? 0;
      if (held > 0) probe.set(ev.tier, held - 1);
      else initial.set(ev.tier, (initial.get(ev.tier) ?? 0) + 1);
    }
  }

  const counts = new Map(initial);
  const initialTier = tierOfSet(counts);
  let current = initialTier;
  const transitions: TierTransition[] = [];

  for (const ev of events) {
    if (ev.kind === "add") counts.set(ev.tier, (counts.get(ev.tier) ?? 0) + 1);
    else if (ev.kind === "remove") counts.set(ev.tier, Math.max(0, (counts.get(ev.tier) ?? 0) - 1));
    else continue;

    const next = tierOfSet(counts);
    if (next === current) continue;
    transitions.push({
      at: new Date(ev.at).toISOString(),
      from: current,
      to: next,
      priceChangeLogged: priceAt.some((p) => Math.abs(p - ev.at) <= PRICE_WINDOW_MS),
    });
    current = next;
  }

  const finalTier = current;
  return {
    subscriptionId,
    initialTier,
    finalTier,
    transitions,
    netDirection: direction(initialTier, finalTier),
    churn: transitions.length > 1,
  };
}

function rank(kind: LogEntryKind["kind"]): number {
  return kind === "add" ? 0 : kind === "remove" ? 1 : 2;
}

function direction(from: Tier, to: Tier): "upgrade" | "downgrade" | "none" {
  // A move involving an unknown tier is not evidence of either direction.
  if (from === "unknown" || to === "unknown" || from === to) return "none";
  return from === "spark" && to === "studio" ? "upgrade" : "downgrade";
}

/** A subscription row as stored, with `log` still in its untyped jsonb form. */
export interface TierChangeRow {
  id: string;
  pricingCohort: string;
  log: unknown;
}

/**
 * jsonb is untyped at the database boundary, and the detail crawl is resumable,
 * so a row with no log at all is a normal state rather than an error. An entry
 * we cannot read is dropped rather than guessed at: a fabricated transition
 * would be reported as fact, whereas a dropped one only makes the count a floor.
 */
function readLog(log: unknown): SealLogEntry[] {
  if (!Array.isArray(log)) return [];
  return log.filter(
    (e): e is SealLogEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as SealLogEntry).created === "string" &&
      typeof (e as SealLogEntry).content === "string"
  );
}

/**
 * Flatten stored subscription rows into the per-change facts the analytics layer
 * folds. Cohort is the subscription's cohort today — the log records the item
 * that moved, never the cohort at the time it moved.
 *
 * priceChangeLogged is deliberately NOT carried across. Seal writes no price
 * entry when the price follows the variant: across all 4,395 logs, 0 of the 81
 * tier changes have a price entry within a minute of them, so the flag is false
 * on every one and discriminates nothing. Mispricing is decided against the
 * price grid in the analytics layer instead.
 */
/** A row of `seal_tier_change_events`, ready to upsert. */
export interface TierChangeEventRow {
  id: string;
  subscriptionId: string;
  changedAt: Date;
  fromTier: Tier;
  toTier: Tier;
  direction: "upgrade" | "downgrade" | "none";
  priceChangeLogged: number;
  pricingCohort: string;
  builtAt: Date;
}

/**
 * Flatten stored logs into the event rows the analytics schema exposes.
 *
 * The fold lives here, in tested TypeScript, and is materialised rather than
 * re-expressed as SQL in the view. A second implementation could disagree with
 * the `subscription_changes` tool — two different upgrade counts for the same
 * month, with nothing to say which is right.
 *
 * `id` is the subscription plus the instant it moved, so a rebuild upserts over
 * the previous run instead of duplicating it, and a subscription that moved
 * twice keeps both moves.
 */
export function buildTierChangeEvents(rows: TierChangeRow[], now: Date): TierChangeEventRow[] {
  const events: TierChangeEventRow[] = [];
  for (const row of rows) {
    for (const t of parseTierHistory(row.id, readLog(row.log)).transitions) {
      events.push({
        id: `${row.id}:${t.at}`,
        subscriptionId: row.id,
        changedAt: new Date(t.at),
        fromTier: t.from,
        toTier: t.to,
        direction: direction(t.from, t.to),
        priceChangeLogged: t.priceChangeLogged ? 1 : 0,
        pricingCohort: row.pricingCohort,
        builtAt: now,
      });
    }
  }
  return events;
}

export function toTierChangeFacts(rows: TierChangeRow[]) {
  const facts = [];
  for (const row of rows) {
    for (const t of parseTierHistory(row.id, readLog(row.log)).transitions) {
      facts.push({
        subscriptionId: row.id,
        at: t.at,
        from: t.from,
        to: t.to,
        pricingCohort: row.pricingCohort,
      });
    }
  }
  return facts;
}
