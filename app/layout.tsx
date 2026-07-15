export const metadata = {
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
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "24px" }}>
        {children}
      </body>
    </html>
  );
}
