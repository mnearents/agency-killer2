/**
 * Syncs product copy, SEO fields and metafields into `shopify_products`.
 *
 * Full replace per run rather than incremental: the catalogue is ~500 products
 * and the question this table answers — "which products have no meta
 * description" — is wrong the moment a row is stale. An incremental sync would
 * leave a product edited in admin looking untouched.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import type { ShopifyApiClient } from "@/integrations/shopify-api";
import { shopifyProducts } from "@/db/schema";
import { PRODUCT_METAFIELDS, PRODUCT_METAFIELD_NAMESPACE } from "./products";

export interface SyncProductsResult {
  products: number;
  withDescription: number;
  withSeoTitle: number;
  withSeoDescription: number;
  /** Per metafield key, how many products have it set. */
  metafieldCoverage: Record<string, number>;
  errors: string[];
}

export async function syncProducts(deps: {
  client: ShopifyApiClient;
  db: Db;
  now?: () => Date;
}): Promise<SyncProductsResult> {
  const now = deps.now ?? (() => new Date());
  const errors: string[] = [];

  const products = await deps.client.getProducts({
    metafieldNamespace: PRODUCT_METAFIELD_NAMESPACE,
  });

  const metafieldCoverage: Record<string, number> = {};
  for (const m of PRODUCT_METAFIELDS) metafieldCoverage[`${m.namespace}.${m.key}`] = 0;

  let withDescription = 0, withSeoTitle = 0, withSeoDescription = 0;

  for (const p of products) {
    if (p.descriptionHtml !== null) withDescription++;
    if (p.seoTitle !== null) withSeoTitle++;
    if (p.seoDescription !== null) withSeoDescription++;
    for (const key of Object.keys(p.metafields)) {
      if (key in metafieldCoverage) metafieldCoverage[key]++;
    }

    try {
      await deps.db
        .insert(shopifyProducts)
        .values({
          id: p.id,
          title: p.title,
          handle: p.handle,
          status: p.status,
          productType: p.productType,
          vendor: p.vendor,
          tags: p.tags,
          descriptionHtml: p.descriptionHtml,
          seoTitle: p.seoTitle,
          seoDescription: p.seoDescription,
          metafields: p.metafields,
          productUpdatedAt: new Date(p.updatedAt),
          syncedAt: now(),
        })
        .onConflictDoUpdate({
          target: shopifyProducts.id,
          set: {
            title: sql`excluded.title`,
            handle: sql`excluded.handle`,
            status: sql`excluded.status`,
            productType: sql`excluded.product_type`,
            vendor: sql`excluded.vendor`,
            tags: sql`excluded.tags`,
            descriptionHtml: sql`excluded.description_html`,
            seoTitle: sql`excluded.seo_title`,
            seoDescription: sql`excluded.seo_description`,
            metafields: sql`excluded.metafields`,
            productUpdatedAt: sql`excluded.product_updated_at`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    } catch (err) {
      errors.push(`${p.handle}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    products: products.length,
    withDescription,
    withSeoTitle,
    withSeoDescription,
    metafieldCoverage,
    errors,
  };
}
