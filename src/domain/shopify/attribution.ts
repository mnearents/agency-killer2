/**
 * Revenue by the page a customer landed on.
 *
 * Each order carries its customer journey from Shopify (first and last visit)
 * since the order sync started requesting it. First touch is what a page is
 * credited with: a blog post brought the customers whose first visit landed
 * on it. Last touch is the page that closed the sale.
 *
 * Renewals are excluded by default — a subscription renewal bills on the 1st
 * without anyone visiting anything — and orders with no journey are counted
 * separately, so an unmeasured page is never reported as one that earned
 * nothing.
 */

import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";

export interface LandingPageRevenue {
  landingPath: string;
  orders: number;
  revenueCents: number;
}

export interface LandingPageQuery {
  since: Date;
  until: Date;
  touch: "first" | "last";
  exact?: string;
  prefix?: string;
  excludeRecurring: boolean;
  limit: number;
}

export async function getRevenueByLandingPage(
  db: Db,
  q: LandingPageQuery,
): Promise<{ rows: LandingPageRevenue[]; matched: number; coverage: { orders: number; withJourney: number } }> {
  const column = sql.raw(q.touch === "first" ? "landing_path" : "last_landing_path");
  const scope = sql`order_created_at >= ${q.since} and order_created_at < ${q.until}
    ${q.excludeRecurring ? sql`and is_recurring = 0` : sql``}`;
  const filter = sql`${q.exact !== undefined ? sql`and ${column} = ${q.exact}` : sql``}
    ${q.prefix !== undefined ? sql`and starts_with(${column}, ${q.prefix})` : sql``}`;

  const [coverage] = (await db.execute(sql`
    select count(*)::int as orders, count(${column})::int as "withJourney"
    from shopify_orders where ${scope}`)) as unknown as { orders: number; withJourney: number }[];

  const rows = (await db.execute(sql`
    select ${column} as "landingPath", count(*)::int as orders, sum(total_price_cents)::bigint as "revenueCents",
           count(*) over ()::int as matched
    from shopify_orders
    where ${scope} and ${column} is not null ${filter}
    group by ${column}
    order by sum(total_price_cents) desc, ${column}
    limit ${q.limit}`)) as unknown as (LandingPageRevenue & { matched: number })[];

  return {
    rows: rows.map((r) => ({ landingPath: r.landingPath, orders: Number(r.orders), revenueCents: Number(r.revenueCents) })),
    matched: rows[0]?.matched ?? 0,
    coverage: { orders: Number(coverage?.orders ?? 0), withJourney: Number(coverage?.withJourney ?? 0) },
  };
}
