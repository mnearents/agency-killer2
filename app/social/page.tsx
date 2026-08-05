import { db } from "@/lib/db";
import {
  getSocialOverview,
  getDailySocialMetrics,
  getFormatStats,
  getTopPosts,
} from "@/domain/social/dashboard-queries";
import { LineChart, BarChart, HorizontalBarChart } from "../components/chart";

export const dynamic = "force-dynamic";

async function getSocialData() {
  const d = db();
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  try {
    const [overview, daily, formats, topPosts] = await Promise.all([
      getSocialOverview(d, startDate, endDate),
      getDailySocialMetrics(d, startDate, endDate),
      getFormatStats(d, startDate, endDate),
      getTopPosts(d, startDate, endDate, 10),
    ]);

    return { overview, daily, formats, topPosts };
  } catch {
    return null;
  }
}

function fmtNum(v: number): string {
  return v.toLocaleString("en-US");
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toFixed(1)}%`;
}

function getFormatLabel(mediaType: string, mediaProductType: string | null): string {
  if (mediaProductType === "REELS") return "Reel";
  if (mediaProductType === "STORY") return "Story";
  if (mediaType === "CAROUSEL_ALBUM") return "Carousel";
  if (mediaType === "VIDEO") return "Video";
  return "Image";
}

const FORMAT_COLORS: Record<string, string> = {
  Reel: "#6f42c1",
  Story: "#e09b13",
  Carousel: "#0969da",
  Image: "#1a7f37",
  Video: "#d1242f",
};

function EngagementPill({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "3px 10px",
        borderRadius: "12px",
        fontSize: "12px",
        fontWeight: 500,
        backgroundColor: `${color}12`,
        color,
      }}
    >
      {label} {value}
    </span>
  );
}

export default async function SocialPage() {
  const data = await getSocialData();

  if (!data) {
    return (
      <div>
        <h1>Organic Social</h1>
        <p style={{ color: "#888" }}>
          Unable to load social data. Check DATABASE_URL and run{" "}
          <code>!sync social</code> in Slack.
        </p>
      </div>
    );
  }

  const { overview, daily, formats, topPosts } = data;

  if (overview.totalPosts === 0) {
    return (
      <div>
        <h1>Organic Social</h1>
        <p style={{ color: "#888" }}>
          No Instagram posts synced yet. Run <code>!sync social</code> in
          Slack to pull your posts and insights.
        </p>
      </div>
    );
  }

  // Trend chart data
  const reachData = daily.map((d) => ({ label: d.date, value: d.reach }));
  const engData = daily.map((d) => {
    const eng = d.likes + d.comments + d.saves + d.shares;
    return { label: d.date, value: eng };
  });
  const savesData = daily.map((d) => ({ label: d.date, value: d.saves }));
  const playsData = daily.map((d) => ({ label: d.date, value: d.plays }));
  const hasPlays = playsData.some((d) => d.value > 0);

  // Format breakdown for horizontal bars
  const engByFormat = formats
    .filter((f) => f.avgEngagementRate !== null)
    .sort((a, b) => (b.avgEngagementRate ?? 0) - (a.avgEngagementRate ?? 0))
    .map((f) => ({
      label: f.format,
      value: f.avgEngagementRate!,
      color: FORMAT_COLORS[f.format] ?? "#555",
    }));

  const savesByFormat = formats
    .filter((f) => f.avgSaveRate !== null)
    .sort((a, b) => (b.avgSaveRate ?? 0) - (a.avgSaveRate ?? 0))
    .map((f) => ({
      label: f.format,
      value: f.avgSaveRate!,
      color: FORMAT_COLORS[f.format] ?? "#555",
    }));

  const reachByFormat = formats
    .sort((a, b) => b.totalReach - a.totalReach)
    .map((f) => ({
      label: f.format,
      value: f.totalReach,
      color: FORMAT_COLORS[f.format] ?? "#555",
    }));

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Organic Social</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        Last 30 days &middot; {overview.totalPosts} post
        {overview.totalPosts !== 1 ? "s" : ""}
      </p>

      {/* ── Summary Cards ────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: "16px",
          marginBottom: "32px",
        }}
      >
        <StatCard label="Total Reach" value={fmtNum(overview.totalReach)} />
        <StatCard
          label="Engagement Rate"
          value={fmtPct(overview.avgEngagementRate)}
          sub="(likes+comments+saves+shares) / reach"
        />
        <StatCard
          label="Save Rate"
          value={fmtPct(overview.avgSaveRate)}
          sub="strongest quality signal"
        />
        <StatCard
          label="Saves"
          value={fmtNum(overview.totalSaves)}
          highlight="#1a7f37"
        />
        <StatCard
          label="Shares"
          value={fmtNum(overview.totalShares)}
          highlight="#6f42c1"
        />
        <StatCard label="Likes" value={fmtNum(overview.totalLikes)} />
        <StatCard label="Comments" value={fmtNum(overview.totalComments)} />
        <StatCard label="Impressions" value={fmtNum(overview.totalImpressions)} />
      </div>

      {/* ── Trend Charts ─────────────────────────────────────────── */}
      {daily.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "16px",
            marginBottom: "32px",
          }}
        >
          <ChartCard>
            <LineChart data={reachData} label="Reach per Post" color="#0969da" />
          </ChartCard>
          <ChartCard>
            <LineChart data={engData} label="Engagements per Post" color="#1a7f37" />
          </ChartCard>
          <ChartCard>
            <BarChart data={savesData} label="Saves per Post" color="#e09b13" />
          </ChartCard>
          {hasPlays && (
            <ChartCard>
              <BarChart data={playsData} label="Video/Reel Plays" color="#6f42c1" />
            </ChartCard>
          )}
        </div>
      )}

      {/* ── Format Comparison ────────────────────────────────────── */}
      {formats.length > 1 && (
        <>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
            Format Comparison
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: "16px",
              marginBottom: "32px",
            }}
          >
            <ChartCard>
              <HorizontalBarChart
                data={engByFormat}
                label="Avg Engagement Rate"
                format="percent"
              />
            </ChartCard>
            <ChartCard>
              <HorizontalBarChart
                data={savesByFormat}
                label="Avg Save Rate"
                format="percent"
              />
            </ChartCard>
            <ChartCard>
              <HorizontalBarChart
                data={reachByFormat}
                label="Total Reach"
                format="number"
              />
            </ChartCard>
          </div>

          {/* Format post count summary */}
          <div
            style={{
              display: "flex",
              gap: "12px",
              marginBottom: "32px",
              flexWrap: "wrap",
            }}
          >
            {formats.map((f) => (
              <div
                key={f.format}
                style={{
                  padding: "8px 16px",
                  borderRadius: "8px",
                  background: "#fff",
                  border: "1px solid #e8e4df",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    backgroundColor: FORMAT_COLORS[f.format] ?? "#555",
                  }}
                />
                <span style={{ fontWeight: 600 }}>{f.count}</span>
                <span style={{ color: "#888", fontSize: "13px" }}>
                  {f.format}{f.count !== 1 ? "s" : ""}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Top Posts ────────────────────────────────────────────── */}
      {topPosts.length > 0 && (
        <>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
            Top Posts by Engagement
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: "16px",
              marginBottom: "32px",
            }}
          >
            {topPosts.map((post, i) => (
              <PostCard key={post.id} post={post} rank={i + 1} />
            ))}
          </div>
        </>
      )}

      {/* ── Slack tip ────────────────────────────────────────────── */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e8e4df",
          borderRadius: "8px",
          padding: "16px",
          color: "#888",
          fontSize: "14px",
        }}
      >
        For AI-powered content strategy recommendations, use{" "}
        <code>!social analyze</code> in Slack.
      </div>
    </div>
  );
}

// ── Reusable components ──────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: string;
}) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e4df",
        borderRadius: "8px",
        padding: "20px",
      }}
    >
      <div style={{ fontSize: "13px", color: "#888", marginBottom: "4px" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "28px",
          fontWeight: 600,
          color: highlight ?? "#2c2c2c",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "11px", color: "#bbb", marginTop: "4px" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function ChartCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e4df",
        borderRadius: "8px",
        padding: "16px",
      }}
    >
      {children}
    </div>
  );
}

function PostCard({
  post,
  rank,
}: {
  post: Awaited<ReturnType<typeof getTopPosts>>[number];
  rank: number;
}) {
  const formatLabel = getFormatLabel(post.mediaType, post.mediaProductType);
  const formatColor = FORMAT_COLORS[formatLabel] ?? "#555";

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e8e4df",
        borderRadius: "8px",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      {/* Header: rank + format + date */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <span
          style={{
            width: "24px",
            height: "24px",
            borderRadius: "50%",
            backgroundColor: rank <= 3 ? "#2c2c2c" : "#e8e4df",
            color: rank <= 3 ? "#fff" : "#888",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {rank}
        </span>
        <span
          style={{
            fontSize: "11px",
            padding: "2px 8px",
            borderRadius: "4px",
            backgroundColor: `${formatColor}18`,
            color: formatColor,
            fontWeight: 600,
          }}
        >
          {formatLabel}
        </span>
        <span style={{ fontSize: "12px", color: "#aaa", marginLeft: "auto" }}>
          {post.postedAt}
        </span>
      </div>

      {/* Caption */}
      <div
        style={{
          fontSize: "13px",
          lineHeight: "1.5",
          color: "#444",
          maxHeight: "60px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {post.caption
          ? post.caption.length > 140
            ? post.caption.slice(0, 140) + "..."
            : post.caption
          : "(no caption)"}
      </div>

      {/* Metrics pills */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
        <EngagementPill
          label="Eng"
          value={fmtPct(post.engagementRate)}
          color="#2c2c2c"
        />
        <EngagementPill
          label="Saves"
          value={String(post.saved)}
          color="#e09b13"
        />
        <EngagementPill
          label="Shares"
          value={String(post.shares)}
          color="#6f42c1"
        />
        <EngagementPill
          label="Reach"
          value={fmtNum(post.reach)}
          color="#0969da"
        />
        {post.plays > 0 && (
          <EngagementPill
            label="Plays"
            value={fmtNum(post.plays)}
            color="#6f42c1"
          />
        )}
      </div>

      {/* Link */}
      {post.permalink && (
        <a
          href={post.permalink}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: "12px",
            color: "#0969da",
            textDecoration: "none",
            marginTop: "auto",
          }}
        >
          View on Instagram &rarr;
        </a>
      )}
    </div>
  );
}
