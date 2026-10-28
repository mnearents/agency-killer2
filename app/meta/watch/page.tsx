import { db } from "@/lib/db";
import { getWatchDashboard, type WatchDashboard } from "@/domain/meta/watch-store";

export const dynamic = "force-dynamic";

const card = { background: "#fff", border: "1px solid #e8e4df", borderRadius: "8px", padding: "16px" };
const cell = { padding: "12px 16px" };

function dollars(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function when(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

const MONEY_FIELDS = new Set(["dailyBudgetCents", "lifetimeBudgetCents", "spendCapCents"]);
const FIELD_LABEL: Record<string, string> = {
  name: "name", status: "status", dailyBudgetCents: "daily budget", lifetimeBudgetCents: "lifetime budget",
  bidStrategy: "bid strategy", spendCapCents: "spend cap", creativeId: "creative",
};
const LEVEL_LABEL: Record<string, string> = { account: "ad account", campaign: "campaign", adset: "ad set", ad: "ad" };

function describeChange(c: WatchDashboard["recentChanges"][number]): string {
  const what = `${LEVEL_LABEL[c.level] ?? c.level} "${c.objectName}"`;
  switch (c.kind) {
    case "created": return `New ${what}`;
    case "removed": return `No longer listed: ${what}`;
    case "edited": return `Edited ${what} (a setting not tracked here)`;
    default: {
      const show = (v: string | null) =>
        v === null ? "none" : c.field && MONEY_FIELDS.has(c.field) ? dollars(Number(v)) : v;
      return `${FIELD_LABEL[c.field ?? ""] ?? c.field} of ${what}: ${show(c.before)} → ${show(c.after)}`;
    }
  }
}

export default async function AdWatchPage() {
  let data: WatchDashboard;
  try {
    data = await getWatchDashboard(db());
  } catch {
    return (
      <div>
        <h1>Ad Account Watch</h1>
        <p style={{ color: "#888" }}>Unable to load the watch. Check DATABASE_URL.</p>
      </div>
    );
  }

  // A failed run newer than the last good snapshot means the numbers below
  // are stale and nothing is currently being watched.
  const failing = data.lastRun !== null && data.lastRun.outcome !== "ok" &&
    (data.checkedAt === null || data.lastRun.finishedAt > data.checkedAt);
  const activeAds = data.campaigns.reduce((sum, c) => sum + c.activeAds, 0);

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Ad Account Watch</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        {data.checkedAt ? `Last checked ${when(data.checkedAt)} (Pacific)` : "Not checked yet"}
        {data.account ? ` · ${data.account.name} · account ${data.account.status ?? "status unknown"}` : ""}
        {data.account?.spendCapCents ? ` · spend cap ${dollars(data.account.spendCapCents)}` : ""}
        {" · checked every 3 hours"}
      </p>

      {failing && (
        <div style={{ ...card, borderColor: "#d1242f", background: "#fff5f5", marginBottom: "24px" }}>
          <strong style={{ color: "#d1242f" }}>The last check failed ({when(data.lastRun!.finishedAt)}).</strong>{" "}
          The figures below are from the last successful check, and changes since then are not being seen.
          {data.lastRun!.errorMessage && (
            <div style={{ marginTop: "8px", fontFamily: "monospace", fontSize: "13px" }}>{data.lastRun!.errorMessage}</div>
          )}
        </div>
      )}

      {data.checkedAt === null ? (
        <p style={{ color: "#888" }}>
          The first check records the account as it is. It runs when the worker starts and every three hours after;
          `!ads watch` in Slack runs it now.
        </p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px", marginBottom: "32px" }}>
            <div style={card}>
              <div style={{ color: "#888", fontSize: "13px" }}>Active campaigns</div>
              <div style={{ fontSize: "28px", fontWeight: 600 }}>{data.campaigns.length}</div>
            </div>
            <div style={card}>
              <div style={{ color: "#888", fontSize: "13px" }}>Daily budget, all active campaigns</div>
              <div style={{ fontSize: "28px", fontWeight: 600 }}>{dollars(data.totalDailyBudgetCents)}</div>
              {data.campaigns.some((c) => c.budgetSource === "lifetime only") && (
                <div style={{ color: "#888", fontSize: "12px" }}>Excludes lifetime-budget campaigns</div>
              )}
            </div>
            <div style={card}>
              <div style={{ color: "#888", fontSize: "13px" }}>Active ads</div>
              <div style={{ fontSize: "28px", fontWeight: 600 }}>{activeAds}</div>
            </div>
          </div>

          <div style={{ overflowX: "auto", marginBottom: "32px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", border: "1px solid #e8e4df", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e8e4df", textAlign: "left" }}>
                  <th style={cell}>Active campaign</th>
                  <th style={{ ...cell, textAlign: "right" }}>Daily budget</th>
                  <th style={cell}>Budget set on</th>
                  <th style={{ ...cell, textAlign: "right" }}>Active ad sets</th>
                  <th style={{ ...cell, textAlign: "right" }}>Active ads</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.length === 0 && (
                  <tr><td style={{ ...cell, color: "#888" }} colSpan={5}>No campaigns are delivering.</td></tr>
                )}
                {data.campaigns.map((c) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid #f0ece7" }}>
                    <td style={cell}>{c.name}</td>
                    <td style={{ ...cell, textAlign: "right" }}>
                      {c.dailyBudgetCents !== null ? dollars(c.dailyBudgetCents)
                        : c.lifetimeBudgetCents !== null ? `${dollars(c.lifetimeBudgetCents)} lifetime` : "—"}
                    </td>
                    <td style={{ ...cell, color: "#888" }}>{c.budgetSource}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{c.activeAdSets}</td>
                    <td style={{ ...cell, textAlign: "right" }}>{c.activeAds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 style={{ fontSize: "18px" }}>Recent changes</h2>
      {data.recentChanges.length === 0 ? (
        <p style={{ color: "#888" }}>
          {data.checkedAt ? "None since the watch started." : "None yet."}
        </p>
      ) : (
        <ul style={{ ...card, listStyle: "none", margin: 0 }}>
          {data.recentChanges.map((c) => (
            <li key={c.id} style={{ padding: "6px 0", borderBottom: "1px solid #f0ece7", fontSize: "14px" }}>
              <span style={{ color: "#888", marginRight: "12px" }}>{when(c.detectedAt)}</span>
              {describeChange(c)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
