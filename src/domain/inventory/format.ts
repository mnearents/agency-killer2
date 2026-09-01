/**
 * Slack formatting for inventory. Tara reads these — plain language,
 * no terminal output, no jargon.
 */

import {
  classifyItem,
  runInventoryChecks,
  type InventoryItem,
  type InventoryCheckOptions,
} from "./checks";

export function formatInventoryOverview(
  items: InventoryItem[],
  options: InventoryCheckOptions = {}
): string {
  if (items.length === 0) {
    return "No inventory data yet — run `!sync inventory` and I'll pull the latest stock levels from Shopify.";
  }

  const active = items.filter(
    (i) => classifyItem(i, options) !== "ignored"
  );

  if (active.length === 0) {
    return "No inventory data yet — nothing in Shopify is set up with stock tracking, so there's nothing for me to watch.";
  }

  const noun = active.length === 1 ? "product" : "products";
  const header = `*Inventory* — watching ${active.length} ${noun}`;

  // runInventoryChecks already orders these by urgency: out of stock,
  // then running low, then slow movers.
  const alerts = runInventoryChecks(items, options);

  if (alerts.length === 0) {
    return `${header}\n\nEverything's healthy — nothing is out of stock or about to run out.`;
  }

  return `${header}\n\n${alerts.map((a) => a.message).join("\n\n")}`;
}
