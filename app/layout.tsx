import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rad & Happy — Marketing Dashboard",
  description: "Marketing automation dashboard for Rad & Happy",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          margin: 0,
          padding: 0,
          backgroundColor: "#faf9f7",
          color: "#2c2c2c",
        }}
      >
        <nav
          style={{
            padding: "16px 24px",
            borderBottom: "1px solid #e8e4df",
            backgroundColor: "#fff",
            display: "flex",
            gap: "24px",
            alignItems: "center",
          }}
        >
          <strong style={{ fontSize: "18px" }}>Rad &amp; Happy</strong>
          <a href="/" style={{ color: "#666", textDecoration: "none" }}>
            Dashboard
          </a>
          <a href="/meta" style={{ color: "#666", textDecoration: "none" }}>
            Meta Ads
          </a>
          <a href="/blog" style={{ color: "#666", textDecoration: "none" }}>
            Blog
          </a>
        </nav>
        <main style={{ padding: "24px", maxWidth: "1200px", margin: "0 auto" }}>
          {children}
        </main>
      </body>
    </html>
  );
}
