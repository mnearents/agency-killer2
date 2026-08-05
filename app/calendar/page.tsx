import { db } from "@/lib/db";
import { getEntriesByMonth } from "@/domain/calendar/queries";
import { CalendarGrid } from "./calendar-grid";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const params = await searchParams;
  const now = new Date();
  const year = params.year ? parseInt(params.year, 10) : now.getFullYear();
  const month = params.month ? parseInt(params.month, 10) : now.getMonth() + 1;

  let entries: Awaited<ReturnType<typeof getEntriesByMonth>> = [];
  try {
    entries = await getEntriesByMonth(db(), year, month);
  } catch {
    // Table may not exist yet
  }

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Marketing Calendar</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        Click a day to add an entry. Click an entry to edit.
      </p>

      <CalendarGrid
        entries={entries}
        initialYear={year}
        initialMonth={month}
      />

      {/* Detail table below the grid */}
      {entries.length > 0 && (
        <div style={{ marginTop: "32px" }}>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
            This Month ({entries.length} entries)
          </h2>
          <div style={{
            background: "#fff",
            border: "1px solid #e8e4df",
            borderRadius: "8px",
            overflow: "hidden",
          }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e8e4df", textAlign: "left" }}>
                  <th style={{ padding: "12px 16px" }}>Date</th>
                  <th style={{ padding: "12px 16px" }}>Channel</th>
                  <th style={{ padding: "12px 16px" }}>Title</th>
                  <th style={{ padding: "12px 16px" }}>Status</th>
                  <th style={{ padding: "12px 16px" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} style={{ borderBottom: "1px solid #f0ece8" }}>
                    <td style={{ padding: "12px 16px", whiteSpace: "nowrap" }}>
                      {new Date(e.date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{
                        fontSize: "12px",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        backgroundColor: getChannelColor(e.channel) + "18",
                        color: getChannelColor(e.channel),
                        fontWeight: 600,
                      }}>
                        {e.channel}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", fontWeight: 500 }}>
                      {e.title}
                      {e.aiSuggested === 1 && (
                        <span style={{ fontSize: "11px", color: "#888", marginLeft: "6px" }}>(AI suggested)</span>
                      )}
                    </td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{
                        fontSize: "12px",
                        padding: "2px 8px",
                        borderRadius: "4px",
                        backgroundColor: e.status === "sent" || e.status === "posted" ? "#e6f4ea" : e.status === "skipped" ? "#f4f0e6" : "#f0f0f0",
                        color: e.status === "sent" || e.status === "posted" ? "#1a7f37" : e.status === "skipped" ? "#8a7a5a" : "#555",
                      }}>
                        {e.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", color: "#888", fontSize: "13px", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {e.notes ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function getChannelColor(channel: string): string {
  const colors: Record<string, string> = {
    Email: "#0969da",
    SMS: "#e09b13",
    Ad: "#d1242f",
    Reel: "#6f42c1",
    Post: "#1a7f37",
    Story: "#cf222e",
    Blog: "#8250df",
  };
  return colors[channel] ?? "#555";
}
