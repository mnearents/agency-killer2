import { db } from "@/lib/db";
import { getOrderSummary, getTopProducts, getDailyOrders } from "@/domain/shopify/queries";
import { LineChart, BarChart } from "../components/chart";

export const dynamic = "force-dynamic";

async function getShopifyData() {
  const d = db();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const summary = await getOrderSummary(d, 30);
    const products = await getTopProducts(d, 15);
    const daily = await getDailyOrders(d, thirtyDaysAgo, new Date());

    return { summary, products, daily };
  } catch {
    return null;
  }
}

function fmtDollar(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function ShopifyPage() {
  const data = await getShopifyData();

  if (!data) {
    return (
      <div>
        <h1>Shopify</h1>
        <p style={{ color: "#888" }}>
          Unable to load Shopify data. Check DATABASE_URL and run{" "}
          <code>!sync shopify</code> in Slack.
        </p>
      </div>
    );
  }

  const { summary, products, daily } = data;

  const revenueData = daily.map((d) => ({
    label: d.date,
    value: d.revenueCents / 100,
  }));
  const orderData = daily.map((d) => ({
    label: d.date,
    value: d.orders,
  }));
  const subData = daily.map((d) => ({
    label: d.date,
    value: d.subscriptionOrders,
  }));

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Shopify</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        Last 30 days
      </p>

      {/* Summary Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "16px",
          marginBottom: "32px",
        }}
      >
        <div style={{ background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "20px" }}>
          <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>Total Orders</div>
          <div style={{ fontSize: "28px", fontWeight: 600 }}>{summary.totalOrders}</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "20px" }}>
          <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>Revenue</div>
          <div style={{ fontSize: "28px", fontWeight: 600 }}>{fmtDollar(summary.totalRevenueCents)}</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "20px" }}>
          <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>Subscriptions</div>
          <div style={{ fontSize: "28px", fontWeight: 600 }}>{summary.subscriptionOrders}</div>
          <div style={{ fontSize: "12px", color: "#aaa", marginTop: "4px" }}>{fmtDollar(summary.subscriptionRevenueCents)}</div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "20px" }}>
          <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>Avg Order Value</div>
          <div style={{ fontSize: "28px", fontWeight: 600 }}>
            {summary.totalOrders > 0
              ? fmtDollar(summary.totalRevenueCents / summary.totalOrders)
              : "—"}
          </div>
        </div>
      </div>

      {/* LTV: use !shopify ltv in Slack for enrollment-based LTV */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e8e4df",
          borderRadius: "8px",
          padding: "16px",
          marginBottom: "32px",
          color: "#888",
          fontSize: "14px",
        }}
      >
        For subscription LTV analysis, use <code>!shopify ltv</code> in Slack — it pulls live enrollment data from Shopify customer metafields.
      </div>

      {/* Trend Charts */}
      {daily.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            marginBottom: "32px",
          }}
        >
          <div style={{ background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "16px" }}>
            <LineChart
              data={revenueData}
              label="Daily Revenue"
              color="#1a7f37"
              format="dollar"
            />
          </div>
          <div style={{ background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "16px" }}>
            <BarChart
              data={orderData}
              label="Daily Orders"
              color="#0969da"
            />
          </div>
        </div>
      )}

      {/* Top Products */}
      {products.length > 0 && (
        <div>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
            Top Products (by order frequency)
          </h2>
          <div
            style={{
              background: "#fff",
              border: "1px solid #e8e4df",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e8e4df", textAlign: "left" }}>
                  <th style={{ padding: "12px 16px" }}>Product</th>
                  <th style={{ padding: "12px 16px" }}>Type</th>
                  <th style={{ padding: "12px 16px", textAlign: "right" }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #f0ece8" }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500 }}>{p.title}</td>
                    <td style={{ padding: "12px 16px", color: "#888" }}>
                      {p.productType ?? "—"}
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      {fmtDollar(p.priceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {summary.totalOrders === 0 && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e8e4df",
            borderRadius: "8px",
            padding: "20px",
            color: "#888",
          }}
        >
          No Shopify data yet. Run <code>!sync shopify</code> in Slack to
          pull orders.
        </div>
      )}
    </div>
  );
}
