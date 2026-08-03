import { db } from "@/lib/db";
import { metaCampaigns, metaInsights, shopifyOrders, blogTopics, socialPosts } from "@/db/schema";
import { eq, gte, count, sum, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function getOverview() {
  const d = db();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const [campaignCount] = await d
      .select({ count: count() })
      .from(metaCampaigns)
      .where(eq(metaCampaigns.status, "ACTIVE"));

    const [insightAgg] = await d
      .select({
        totalSpendCents: sum(metaInsights.spendCents),
        totalRevenueCents: sum(metaInsights.purchaseValueCents),
        totalImpressions: sum(metaInsights.impressions),
      })
      .from(metaInsights)
      .where(gte(metaInsights.date, sevenDaysAgo));

    const orderRows = await d
      .select({
        totalPriceCents: shopifyOrders.totalPriceCents,
        isRecurring: shopifyOrders.isRecurring,
      })
      .from(shopifyOrders)
      .where(gte(shopifyOrders.orderCreatedAt, sevenDaysAgo));

    let weeklyOrders = 0;
    let weeklyShopifyRevenue = 0;
    let weeklySubOrders = 0;
    for (const row of orderRows) {
      weeklyOrders++;
      weeklyShopifyRevenue += Number(row.totalPriceCents);
      if (row.isRecurring === 1) weeklySubOrders++;
    }

    const [pendingTopics] = await d
      .select({ count: count() })
      .from(blogTopics)
      .where(eq(blogTopics.status, "pending"));

    // Social overview (last 7 days) — table may not exist yet
    let socialReach = 0;
    let socialEng = 0;
    let socialPostCount = 0;
    let socialSavesCount = 0;
    try {
      const [socialAgg] = await d
        .select({
          totalPosts: count(),
          totalReach: sql<number>`COALESCE(SUM(${socialPosts.reach}), 0)`,
          totalSaves: sql<number>`COALESCE(SUM(${socialPosts.saved}), 0)`,
          totalLikes: sql<number>`COALESCE(SUM(${socialPosts.likeCount}), 0)`,
          totalComments: sql<number>`COALESCE(SUM(${socialPosts.commentsCount}), 0)`,
          totalShares: sql<number>`COALESCE(SUM(${socialPosts.shares}), 0)`,
        })
        .from(socialPosts)
        .where(gte(socialPosts.postedAt, sevenDaysAgo));

      socialPostCount = Number(socialAgg?.totalPosts ?? 0);
      socialSavesCount = Number(socialAgg?.totalSaves ?? 0);
      socialReach = Number(socialAgg?.totalReach ?? 0);
      socialEng =
        Number(socialAgg?.totalLikes ?? 0) +
        Number(socialAgg?.totalComments ?? 0) +
        Number(socialAgg?.totalSaves ?? 0) +
        Number(socialAgg?.totalShares ?? 0);
    } catch {
      // Table may not exist yet — non-fatal
    }

    return {
      activeCampaigns: campaignCount?.count ?? 0,
      weeklySpend: Number(insightAgg?.totalSpendCents ?? 0) / 100,
      weeklyAdRevenue: Number(insightAgg?.totalRevenueCents ?? 0) / 100,
      weeklyImpressions: Number(insightAgg?.totalImpressions ?? 0),
      weeklyOrders,
      weeklyShopifyRevenue: weeklyShopifyRevenue / 100,
      weeklySubOrders,
      pendingBlogTopics: pendingTopics?.count ?? 0,
      socialPosts: socialPostCount,
      socialReach,
      socialEngRate: socialReach > 0 ? (socialEng / socialReach) * 100 : null,
      socialSaves: socialSavesCount,
    };
  } catch {
    return null;
  }
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e4df",
        borderRadius: "8px",
        padding: "20px",
        minWidth: "180px",
      }}
    >
      <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>
        {label}
      </div>
      <div style={{ fontSize: "28px", fontWeight: 600 }}>{value}</div>
      {sub && (
        <div style={{ fontSize: "12px", color: "#aaa", marginTop: "4px" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export default async function Home() {
  const data = await getOverview();

  if (!data) {
    return (
      <div>
        <h1>Rad &amp; Happy</h1>
        <p>Dashboard is running. Waiting for data sync to populate.</p>
        <p style={{ color: "#888" }}>
          Make sure DATABASE_URL is set and the worker is running.
        </p>
      </div>
    );
  }

  const roas =
    data.weeklySpend > 0
      ? (data.weeklyAdRevenue / data.weeklySpend).toFixed(2)
      : "N/A";

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Dashboard</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        Last 7 days
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "16px",
          marginBottom: "32px",
        }}
      >
        <StatCard
          label="Active Campaigns"
          value={String(data.activeCampaigns)}
        />
        <StatCard
          label="Ad Spend"
          value={`$${data.weeklySpend.toFixed(2)}`}
          sub="last 7 days"
        />
        <StatCard
          label="Ad Revenue"
          value={`$${data.weeklyAdRevenue.toFixed(2)}`}
          sub="attributed to ads"
        />
        <StatCard label="ROAS" value={`${roas}x`} />
        <StatCard
          label="Shopify Revenue"
          value={`$${data.weeklyShopifyRevenue.toFixed(2)}`}
          sub="all orders"
        />
        <StatCard
          label="Orders"
          value={String(data.weeklyOrders)}
          sub={data.weeklySubOrders > 0 ? `${data.weeklySubOrders} subscriptions` : "last 7 days"}
        />
        <StatCard
          label="Impressions"
          value={data.weeklyImpressions.toLocaleString()}
        />
        <StatCard
          label="Blog Topics"
          value={String(data.pendingBlogTopics)}
          sub="pending"
        />
        {data.socialPosts > 0 && (
          <StatCard
            label="IG Engagement"
            value={data.socialEngRate !== null ? `${data.socialEngRate.toFixed(1)}%` : "—"}
            sub={`${data.socialPosts} posts, ${data.socialSaves} saves`}
          />
        )}
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #e8e4df",
          borderRadius: "8px",
          padding: "20px",
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: "16px" }}>Slack Commands</h2>
        <ul style={{ lineHeight: "1.8", color: "#555" }}>
          <li>
            <code>!ads report</code> — AI-generated performance analysis
          </li>
          <li>
            <code>!ads status</code> — Quick campaign metrics
          </li>
          <li>
            <code>!email design &lt;brief&gt;</code> — Generate email creative
          </li>
          <li>
            <code>!blog create &lt;topic&gt;</code> — Generate blog article
          </li>
          <li>
            <code>!blog list</code> — Pending blog topics
          </li>
          <li>
            <code>!social analyze</code> — AI content strategy insights
          </li>
          <li>Or just ask anything in plain English</li>
        </ul>
      </div>
    </div>
  );
}
