/**
 * Cost entry (#34) — the only page on the dashboard that writes.
 *
 * Everything happens client-side against /api/costs, which carries the auth.
 * The browser prompts for credentials on the first fetch and reuses them, so
 * there is no session, no cookie and no second place where access is decided.
 */

"use client";

import { useEffect, useState } from "react";

interface Cost {
  id: string;
  name: string;
  vendor: string | null;
  amountDollars: number;
  cadence: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  open: boolean;
}

const CADENCES = [
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
  { value: "per_bill_period", label: "Per 3PL bill period (2 weeks)" },
];

export default function CostsPage() {
  const [costs, setCosts] = useState<Cost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState("monthly");
  const [effectiveFrom, setEffectiveFrom] = useState("");

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/costs", { credentials: "include" });
      if (!res.ok) {
        setError(
          res.status === 503
            ? "Cost entry is not configured on this deployment."
            : `Could not load costs (${res.status}).`,
        );
        return;
      }
      const body = await res.json();
      setCosts(body.costs);
    } catch {
      setError("Could not reach the server.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name,
          vendor,
          cadence,
          effectiveFrom,
          amountDollars: Number(amount),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `Failed (${res.status}).`);
        return;
      }
      // The three outcomes need different words: an unchanged cost is not a
      // save, and a changed one closed a previous row that the operator should
      // know about.
      setStatus(
        body.action === "unchanged"
          ? `${name} is already recorded at that amount — nothing changed.`
          : body.action === "changed"
            ? `${name} updated from $${body.previousDollars} — the old rate was closed on ${effectiveFrom}.`
            : `${name} recorded.`,
      );
      setName("");
      setVendor("");
      setAmount("");
      await load();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.25rem" }}>Recurring costs</h1>
      <p style={{ color: "#555", marginTop: 0, fontSize: "0.9rem" }}>
        Fixed overhead — software and subscriptions that do not vary with orders. These are kept
        out of cost of delivery on purpose: a fixed fee folded into a per-order cost would make it
        move with volume. Costs the 3PL bills are imported automatically and appear here as{" "}
        <code>threepl</code>.
      </p>

      <form onSubmit={submit} style={{ display: "grid", gap: "0.75rem", margin: "1.5rem 0" }}>
        <label>
          Name
          <input required value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Shopify Plus" style={inputStyle} />
        </label>
        <label>
          Vendor (optional)
          <input value={vendor} onChange={(e) => setVendor(e.target.value)}
            placeholder="Shopify" style={inputStyle} />
        </label>
        <label>
          Amount (USD)
          <input required type="number" step="0.01" min="0" value={amount}
            onChange={(e) => setAmount(e.target.value)} placeholder="2500.00" style={inputStyle} />
        </label>
        <label>
          Cadence
          <select value={cadence} onChange={(e) => setCadence(e.target.value)} style={inputStyle}>
            {CADENCES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label>
          Effective from
          <input required type="date" value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)} style={inputStyle} />
          <span style={{ display: "block", fontSize: "0.8rem", color: "#666", marginTop: 2 }}>
            Changing an amount closes the previous rate on this date rather than overwriting it, so
            a margin computed for an earlier month still uses that month&apos;s cost.
          </span>
        </label>
        <button type="submit" disabled={saving} style={buttonStyle}>
          {saving ? "Saving…" : "Record cost"}
        </button>
      </form>

      {error && <p style={{ color: "#b00", fontSize: "0.9rem" }}>{error}</p>}
      {status && <p style={{ color: "#060", fontSize: "0.9rem" }}>{status}</p>}

      <h2 style={{ fontSize: "1.1rem", marginTop: "2rem" }}>Recorded</h2>
      {costs === null && !error && <p style={{ color: "#666" }}>Loading…</p>}
      {costs !== null && costs.length === 0 && (
        <p style={{ color: "#666" }}>Nothing recorded yet.</p>
      )}
      {costs !== null && costs.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={cell}>Name</th><th style={cell}>Amount</th><th style={cell}>Cadence</th>
              <th style={cell}>From</th><th style={cell}>To</th><th style={cell}>Source</th>
            </tr>
          </thead>
          <tbody>
            {costs.map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid #f0f0f0", opacity: c.open ? 1 : 0.55 }}>
                <td style={cell}>{c.name}{c.vendor ? ` · ${c.vendor}` : ""}</td>
                <td style={cell}>${c.amountDollars.toFixed(2)}</td>
                <td style={cell}>{c.cadence}</td>
                <td style={cell}>{c.effectiveFrom}</td>
                <td style={cell}>{c.effectiveTo ?? "current"}</td>
                <td style={cell}>{c.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", padding: "0.5rem", marginTop: 4,
  border: "1px solid #ccc", borderRadius: 4, fontSize: "0.95rem",
};
const buttonStyle: React.CSSProperties = {
  padding: "0.6rem 1rem", background: "#111", color: "#fff",
  border: "none", borderRadius: 4, cursor: "pointer", fontSize: "0.95rem", justifySelf: "start",
};
const cell: React.CSSProperties = { padding: "0.4rem 0.5rem" };
