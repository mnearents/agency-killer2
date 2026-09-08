/**
 * Pulls every Shopify customer, writes them, then recomputes the rollup.
 *
 * Order matters and is enforced rather than assumed: the rollup only runs once
 * the customer table has actually been written, and never runs at all if the
 * fetch failed. A rollup over a half-written table produces counts that look
 * authoritative and describe nothing — the same shape as every other
 * success-signal-with-no-work bug this project has hit.
 */

import type { ShopifyApiClient } from "@/integrations/shopify-api";
import type { Db } from "@/db/client";
import { shopifyCustomers } from "@/db/schema";
import { transformCustomer } from "./customer-transform";
import { rollupCustomers, type RollupResult } from "./customer-rollup";

export interface CustomerSyncDeps {
  client: ShopifyApiClient;
  db: Db;
  /**
   * Injected at the same seam as the API client. Keeping it a dependency rather
   * than a direct call is what makes "the rollup did not run" an assertable
   * fact instead of something inferred from a log line.
   */
  rollup?: (db: Db, derivedAt: Date) => Promise<RollupResult>;
}

export interface CustomerSyncResult {
  customers: number;
  /** Null means the rollup did not run. Zeroes would read as "ran, found none". */
  rollup: RollupResult | null;
  errors: string[];
}

export async function syncCustomers(deps: CustomerSyncDeps): Promise<CustomerSyncResult> {
  const { client, db, rollup = rollupCustomers } = deps;
  const syncedAt = new Date();
  const errors: string[] = [];
  let customers = 0;

  try {
    const profiles = await client.getCustomerProfiles();

    for (const raw of profiles) {
      const row = transformCustomer(raw, syncedAt);
      await db
        .insert(shopifyCustomers)
        .values(row)
        .onConflictDoUpdate({
          target: shopifyCustomers.id,
          // Only the Shopify-sourced columns. The derived columns are the
          // rollup's to own; listing them here would blank them on every sync.
          set: { ...row, updatedAt: syncedAt },
        });
      customers++;
    }
  } catch (err) {
    errors.push(`Customers: ${err instanceof Error ? err.message : String(err)}`);
    return { customers, rollup: null, errors };
  }

  try {
    // Same timestamp as the rows it summarises, so derived_at and synced_at can
    // be compared to tell a stale rollup from a current one.
    const result = await rollup(db, syncedAt);
    return { customers, rollup: result, errors };
  } catch (err) {
    errors.push(`Rollup: ${err instanceof Error ? err.message : String(err)}`);
    return { customers, rollup: null, errors };
  }
}
