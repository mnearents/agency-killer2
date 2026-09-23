/**
 * Reads over `shopify_products`, for the MCP surface.
 *
 * Every text field is nullable and NULL means never set. Nothing here
 * substitutes an empty string for a missing one: "this product has no meta
 * description" and "its meta description is blank" are the same to a reader
 * and different to whoever has to fix it.
 */

import { sql, eq, or, ilike, desc } from "drizzle-orm";
import type { Db } from "@/db/client";
import { shopifyProducts } from "@/db/schema";
import type { ProductSeoFacts } from "./products";

export interface ProductRow extends ProductSeoFacts {
  productType: string | null;
  vendor: string | null;
  tags: string[] | null;
  seoTitleRaw: string | null;
  syncedAt: string | null;
}

export async function findProducts(
  db: Db,
  options: { search?: string; status?: string; limit: number },
): Promise<{ rows: ProductRow[]; matched: number }> {
  const conditions = [];
  if (options.search) {
    const needle = `%${options.search}%`;
    conditions.push(or(ilike(shopifyProducts.title, needle), ilike(shopifyProducts.handle, needle)));
  }
  if (options.status) conditions.push(eq(shopifyProducts.status, options.status));
  const where = conditions.length > 0 ? sql.join(conditions, sql` and `) : undefined;

  const [{ matched }] = await db
    .select({ matched: sql<number>`count(*)::int` })
    .from(shopifyProducts)
    .where(where);

  const rows = await db
    .select({
      id: shopifyProducts.id,
      title: shopifyProducts.title,
      handle: shopifyProducts.handle,
      status: shopifyProducts.status,
      productType: shopifyProducts.productType,
      vendor: shopifyProducts.vendor,
      tags: shopifyProducts.tags,
      descriptionHtml: shopifyProducts.descriptionHtml,
      seoTitle: shopifyProducts.seoTitle,
      seoTitleRaw: shopifyProducts.seoTitle,
      seoDescription: shopifyProducts.seoDescription,
      metafields: shopifyProducts.metafields,
      syncedAt: sql<string | null>`${shopifyProducts.syncedAt}::text`,
    })
    .from(shopifyProducts)
    .where(where)
    .orderBy(desc(shopifyProducts.productUpdatedAt))
    .limit(options.limit);

  return { rows, matched };
}

/** Every product, for an audit that has to be complete rather than sampled. */
export async function allProductsForAudit(db: Db): Promise<ProductRow[]> {
  const { rows } = await findProducts(db, { limit: 5000 });
  return rows;
}

export async function getProductCoverage(db: Db): Promise<{
  products: number;
  active: number;
  withDescription: number;
  withSeoTitle: number;
  withSeoDescription: number;
  lastSyncedAt: string | null;
}> {
  const [row] = await db
    .select({
      products: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${shopifyProducts.status} = 'ACTIVE')::int`,
      withDescription: sql<number>`count(${shopifyProducts.descriptionHtml})::int`,
      withSeoTitle: sql<number>`count(${shopifyProducts.seoTitle})::int`,
      withSeoDescription: sql<number>`count(${shopifyProducts.seoDescription})::int`,
      lastSyncedAt: sql<string | null>`max(${shopifyProducts.syncedAt})::text`,
    })
    .from(shopifyProducts);
  return row;
}
