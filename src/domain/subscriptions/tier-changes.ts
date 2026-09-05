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
