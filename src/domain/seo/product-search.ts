/**
 * Search Console performance joined to product copy.
 *
 * The join is the URL path: Search Console stores a `page` row per URL, and a
 * Shopify product page is `/products/<handle>`. Everything else — collections,
 * pages, blogs, the home page — has no product behind it and is reported as
 * unmatched rather than dropped, because "this product gets no traffic" and
 * "this URL is not a product" are different answers.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";

/** `https://radandhappy.com/products/foo?x=1` -> `foo`. Null for anything else. */
export function handleFromUrl(url: string): string | null {
  const match = url.match(/\/products\/([^/?#]+)/);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]).toLowerCase();
  return handle === "" ? null : handle;
}

export interface ProductSearchRow {
  handle: string;
  title: string | null;
  status: string | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  seoTitle: string | null;
  seoDescription: string | null;
  descriptionHtml: string | null;
  /** False when the URL ranks but no product in the catalogue has that handle. */
  productFound: boolean;
}

export interface ProductSearchSummary {
  urlsWithTraffic: number;
  productUrls: number;
  matchedToProduct: number;
  /** Product URLs ranking for a handle no product has — usually renamed or deleted. */
  unmatchedProductUrls: string[];
  /** Products in the catalogue with no search impressions at all. */
  productsWithNoImpressions: number;
}

/**
 * Per-product search performance over a window.
 *
 * Position is impression-weighted and CTR is computed from totals, matching
 * `search_performance` — averaging the daily figures would weight a quiet day
 * like a busy one.
 */
export async function getProductSearchPerformance(
  db: Db,
  range: { from: string; to: string },
  limit: number,
): Promise<{ rows: ProductSearchRow[]; summary: ProductSearchSummary }> {
  const rows = await db.execute(sql`
    with pages as (
      select
        lower(substring(value from '/products/([^/?#]+)')) as handle,
        sum(clicks)::int as clicks,
        sum(impressions)::int as impressions,
        case when sum(impressions) > 0
             then round((sum(position * impressions) / sum(impressions))::numeric, 2)
             else null end as position
      from gsc_daily
      where dimension = 'page'
        and date between ${range.from} and ${range.to}
        and value like '%/products/%'
      group by 1
    )
    select
      p.handle,
      sp.title,
      sp.status,
      p.clicks,
      p.impressions,
      case when p.impressions > 0
           then round((p.clicks::numeric / p.impressions), 4) else null end as ctr,
      p.position,
      sp.seo_title as "seoTitle",
      sp.seo_description as "seoDescription",
      sp.description_html as "descriptionHtml",
      (sp.id is not null) as "productFound"
    from pages p
    left join shopify_products sp on sp.handle = p.handle
    where p.handle is not null
    order by p.clicks desc, p.impressions desc
    limit ${limit}
  `);

  const [summary] = await db.execute(sql`
    with pages as (
      select value,
             lower(substring(value from '/products/([^/?#]+)')) as handle
      from gsc_daily
      where dimension = 'page' and date between ${range.from} and ${range.to}
      group by 1
    )
    select
      (select count(*)::int from pages) as "urlsWithTraffic",
      (select count(*)::int from pages where handle is not null) as "productUrls",
      (select count(*)::int from pages p join shopify_products sp on sp.handle = p.handle) as "matchedToProduct",
      (select count(*)::int from shopify_products sp
        where sp.status = 'ACTIVE'
          and not exists (select 1 from pages p where p.handle = sp.handle)) as "productsWithNoImpressions"
  `) as unknown as ProductSearchSummary[];

  const unmatched = await db.execute(sql`
    with pages as (
      select value, lower(substring(value from '/products/([^/?#]+)')) as handle
      from gsc_daily
      where dimension = 'page' and date between ${range.from} and ${range.to}
      group by 1
    )
    select p.handle from pages p
    left join shopify_products sp on sp.handle = p.handle
    where p.handle is not null and sp.id is null
    limit 15
  `);

  return {
    rows: rows as unknown as ProductSearchRow[],
    summary: {
      ...summary,
      unmatchedProductUrls: (unmatched as unknown as { handle: string }[]).map((u) => u.handle),
    },
  };
}
