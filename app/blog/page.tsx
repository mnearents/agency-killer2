import { db } from "@/lib/db";
import { blogTopics, blogGenerations } from "@/db/schema";
import { desc, eq, count } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function getBlogData() {
  const d = db();

  try {
    const topics = await d
      .select()
      .from(blogTopics)
      .orderBy(desc(blogTopics.createdAt));

    const [genCount] = await d
      .select({ count: count() })
      .from(blogGenerations);

    return {
      topics,
      totalGenerations: genCount?.count ?? 0,
    };
  } catch {
    return null;
  }
}

export default async function BlogPage() {
  const data = await getBlogData();

  if (!data) {
    return (
      <div>
        <h1>Blog</h1>
        <p style={{ color: "#888" }}>
          Unable to load blog data. Check DATABASE_URL.
        </p>
      </div>
    );
  }

  const pending = data.topics.filter((t) => t.status === "pending");
  const published = data.topics.filter((t) => t.status === "published");

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Blog</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "24px" }}>
        {data.topics.length} topics · {data.totalGenerations} articles generated
      </p>

      {pending.length > 0 && (
        <div style={{ marginBottom: "32px" }}>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
            Pending Topics ({pending.length})
          </h2>
          <div
            style={{
              background: "#fff",
              border: "1px solid #e8e4df",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            {pending.map((t, i) => (
              <div
                key={t.id}
                style={{
                  padding: "14px 16px",
                  borderBottom:
                    i < pending.length - 1 ? "1px solid #f0ece8" : "none",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div>
                  <div style={{ fontWeight: 500 }}>{t.title}</div>
                  {t.description && (
                    <div
                      style={{ fontSize: "13px", color: "#888", marginTop: "4px" }}
                    >
                      {t.description}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                  {t.targetDate && (
                    <span style={{ fontSize: "12px", color: "#888" }}>
                      Target: {t.targetDate.toISOString().split("T")[0]}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: "12px",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      backgroundColor: "#f4f0e6",
                      color: "#8a7a5a",
                    }}
                  >
                    Priority {t.priority}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {published.length > 0 && (
        <div>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>
            Published ({published.length})
          </h2>
          <div
            style={{
              background: "#fff",
              border: "1px solid #e8e4df",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            {published.map((t, i) => (
              <div
                key={t.id}
                style={{
                  padding: "14px 16px",
                  borderBottom:
                    i < published.length - 1 ? "1px solid #f0ece8" : "none",
                }}
              >
                <span style={{ fontWeight: 500 }}>{t.title}</span>
                <span
                  style={{
                    fontSize: "12px",
                    marginLeft: "12px",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    backgroundColor: "#e6f4ea",
                    color: "#1a7f37",
                  }}
                >
                  Published
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.topics.length === 0 && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e8e4df",
            borderRadius: "8px",
            padding: "20px",
            color: "#888",
          }}
        >
          No blog topics yet. Add one via Slack:{" "}
          <code>!blog create planner organization tips</code>
        </div>
      )}
    </div>
  );
}
