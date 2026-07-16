import { db } from "@/lib/db";
import { metaCampaigns, metaInsights } from "@/db/schema";
import { eq, gte, and, desc } from "drizzle-orm";
import { aggregateAndCompute, type InsightRow } from "@/domain/meta/metrics";

export const dynamic = "force-dynamic";

async function getCampaignData() {
  const d = db();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const campaigns = await d
      .select()
      .from(metaCampaigns)
      .orderBy(desc(metaCampaigns.updatedAt));

    const results = [];

    for (const campaign of campaigns) {
      const rows = await d
        .select({
          spendCents: metaInsights.spendCents,
          impressions: metaInsights.impressions,
          clicks: metaInsights.clicks,
          reach: metaInsights.reach,
          purchases: metaInsights.purchases,
          purchaseValueCents: metaInsights.purchaseValueCents,
          addToCart: metaInsights.addToCart,
          initiateCheckout: metaInsights.initiateCheckout,
        })
        .from(metaInsights)
        .where(
          and(
            eq(metaInsights.campaignId, campaign.id),
            gte(metaInsights.date, thirtyDaysAgo)
          )
        );

      const insightRows: InsightRow[] = rows.map((r) => ({
        spendCents: r.spendCents,
        impressions: Number(r.impressions),
        clicks: Number(r.clicks),
        reach: Number(r.reach),
        purchases: r.purchases,
        purchaseValueCents: r.purchaseValueCents,
        addToCart: r.addToCart,
        initiateCheckout: r.initiateCheckout,
      }));

      const metrics = aggregateAndCompute(insightRows);

      results.push({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        objective: campaign.objective,
        metrics,
      });
    }

    return results;
  } catch {
    return null;
  }
}

function fmt(v: number | null, decimals = 2): string {
  if (v === null) return "—";
  return v.toFixed(decimals);
}

export default async function MetaPage() {
  const campaigns = await getCampaignData();

  if (!campaigns) {
    return (
      <div>
        <h1>Meta Ads</h1>
        <p style={{ color: "#888" }}>
          Unable to load campaign data. Check DATABASE_URL and run Meta sync.
        </p>
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <div>
        <h1>Meta Ads</h1>
        <p style={{ color: "#888" }}>
          No campaigns found. Data will appear after the first Meta sync runs.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Meta Ads</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        Last 30 days · {campaigns.length} campaign
        {campaigns.length !== 1 ? "s" : ""}
      </p>

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            background: "#fff",
            border: "1px solid #e8e4df",
            borderRadius: "8px",
            fontSize: "14px",
          }}
        >
          <thead>
            <tr
              style={{
                borderBottom: "2px solid #e8e4df",
                textAlign: "left",
              }}
            >
              <th style={{ padding: "12px 16px" }}>Campaign</th>
              <th style={{ padding: "12px 16px" }}>Status</th>
              <th style={{ padding: "12px 16px", textAlign: "right" }}>
                Spend
              </th>
              <th style={{ padding: "12px 16px", textAlign: "right" }}>
                Revenue
              </th>
              <th style={{ padding: "12px 16px", textAlign: "right" }}>
                ROAS
              </th>
              <th style={{ padding: "12px 16px", textAlign: "right" }}>CTR</th>
              <th style={{ padding: "12px 16px", textAlign: "right" }}>CPC</th>
              <th style={{ padding: "12px 16px", textAlign: "right" }}>
                Purchases
              </th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr
                key={c.id}
                style={{ borderBottom: "1px solid #f0ece8" }}
              >
                <td style={{ padding: "12px 16px", fontWeight: 500 }}>
                  {c.name}
                </td>
                <td style={{ padding: "12px 16px" }}>
                  <span
                    style={{
                      fontSize: "12px",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      backgroundColor:
                        c.status === "ACTIVE" ? "#e6f4ea" : "#f4f0e6",
                      color: c.status === "ACTIVE" ? "#1a7f37" : "#8a7a5a",
                    }}
                  >
                    {c.status}
                  </span>
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  ${fmt(c.metrics.spendDollars)}
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  ${fmt(c.metrics.revenueDollars)}
                </td>
                <td
                  style={{
                    padding: "12px 16px",
                    textAlign: "right",
                    fontWeight: 600,
                    color:
                      c.metrics.roas !== null && c.metrics.roas >= 1
                        ? "#1a7f37"
                        : c.metrics.roas !== null
                          ? "#d1242f"
                          : "#888",
                  }}
                >
                  {c.metrics.roas !== null ? `${fmt(c.metrics.roas)}x` : "—"}
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  {c.metrics.ctr !== null ? `${fmt(c.metrics.ctr)}%` : "—"}
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  {c.metrics.cpc !== null ? `$${fmt(c.metrics.cpc)}` : "—"}
                </td>
                <td style={{ padding: "12px 16px", textAlign: "right" }}>
                  {c.metrics.revenueDollars > 0 && c.metrics.costPerPurchaseDollars
                    ? Math.round(
                        c.metrics.revenueDollars /
                          c.metrics.costPerPurchaseDollars
                      )
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
