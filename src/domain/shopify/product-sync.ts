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
import { shopifyProducts, shopifyRedirects } from "@/db/schema";
import { resolveProductRedirect, type Fetcher } from "@/domain/seo/redirects";
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

/**
 * Resolves product URLs that Search Console has but the catalogue does not.
 *
 * Run after the product sync, so "no product with this handle" means what it
 * says. Only unmatched handles are fetched — resolving all 290 every day would
 * be 290 HTTP requests to answer a question about roughly fifteen.
 */
export async function resolveMissingRedirects(deps: {
  db: Db;
  storeUrl: string;
  fetcher: Fetcher;
  /** Bounded so one bad day cannot turn into hundreds of requests. */
  maxToResolve?: number;
}): Promise<{ checked: number; redirected: number; dead: number; errors: string[] }> {
  const max = deps.maxToResolve ?? 50;
  const errors: string[] = [];

  const missing = await deps.db.execute(sql`
    select distinct lower(substring(g.value from '/products/([^/?#]+)')) as handle
    from gsc_daily g
    where g.dimension = 'page'
      and g.value like '%/products/%'
      and g.date >= current_date - 365
      and not exists (
        select 1 from shopify_products p
        where p.handle = lower(substring(g.value from '/products/([^/?#]+)')))
      and not exists (
        select 1 from shopify_redirects r
        where r.from_handle = lower(substring(g.value from '/products/([^/?#]+)'))
          and r.resolved_at > now() - interval '30 days')
    limit ${max}
  `);

  let redirected = 0;
  let dead = 0;

  for (const row of missing as unknown as { handle: string | null }[]) {
    if (!row.handle) continue;
    try {
      const resolution = await resolveProductRedirect(deps.storeUrl, row.handle, deps.fetcher);
      if (resolution.toHandle !== null) redirected++;
      else if (resolution.statusCode === 404) dead++;

      await deps.db
        .insert(shopifyRedirects)
        .values({
          fromHandle: resolution.fromHandle,
          toHandle: resolution.toHandle,
          statusCode: resolution.statusCode,
          finalUrl: resolution.finalUrl,
          resolvedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: shopifyRedirects.fromHandle,
          set: {
            toHandle: sql`excluded.to_handle`,
            statusCode: sql`excluded.status_code`,
            finalUrl: sql`excluded.final_url`,
            resolvedAt: sql`excluded.resolved_at`,
          },
        });
    } catch (err) {
      errors.push(`${row.handle}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { checked: (missing as unknown as unknown[]).length, redirected, dead, errors };
}
