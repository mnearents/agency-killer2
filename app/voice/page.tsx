import { db } from "@/lib/db";
import { getAllSamples, getAllRules, getAllBannedWords } from "@/domain/voice/queries";
import {
  addVoiceSample, editVoiceSample, removeVoiceSample,
  addVoiceRule, removeVoiceRule,
  addVoiceBannedWord, removeVoiceBannedWord,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function VoicePage() {
  let samples: Awaited<ReturnType<typeof getAllSamples>> = [];
  let rules: Awaited<ReturnType<typeof getAllRules>> = [];
  let bannedWords: Awaited<ReturnType<typeof getAllBannedWords>> = [];

  try {
    [samples, rules, bannedWords] = await Promise.all([
      getAllSamples(db()),
      getAllRules(db()),
      getAllBannedWords(db()),
    ]);
  } catch {
    // Tables may not exist yet
  }

  return (
    <div>
      <h1 style={{ marginBottom: "8px" }}>Brand Voice</h1>
      <p style={{ color: "#888", marginTop: 0, marginBottom: "32px" }}>
        Writing samples, rules, and banned words that shape all AI-generated copy.
      </p>

      {/* ── Writing Samples ──────────────────────────────── */}
      <div style={{ marginBottom: "40px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <h2 style={{ fontSize: "16px", margin: 0 }}>Writing Samples ({samples.length})</h2>
        </div>

        {/* Add sample form */}
        <form action={addVoiceSample} style={{ ...cardStyle, marginBottom: "16px" }}>
          <div style={{ display: "flex", gap: "12px", marginBottom: "8px" }}>
            <input name="title" placeholder="Title (e.g., IG Caption — Planner Launch)" required style={{ ...inputStyle, flex: 1 }} />
            <input name="tags" placeholder="Tags (comma separated)" style={{ ...inputStyle, width: "200px" }} />
          </div>
          <textarea name="content" placeholder="Paste the writing sample here..." required rows={4} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
          <button type="submit" style={{ ...btnStyle, marginTop: "8px" }}>Add Sample</button>
        </form>

        {/* Sample list */}
        {samples.map((s) => (
          <div key={s.id} style={{ ...cardStyle, marginBottom: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
              <div>
                <strong>{s.title}</strong>
                {(s.tags as string[])?.length > 0 && (
                  <span style={{ fontSize: "12px", color: "#888", marginLeft: "8px" }}>
                    {(s.tags as string[]).join(", ")}
                  </span>
                )}
              </div>
              <form action={removeVoiceSample}>
                <input type="hidden" name="id" value={s.id} />
                <button type="submit" style={deleteLinkStyle}>remove</button>
              </form>
            </div>
            <div style={{ fontSize: "13px", color: "#555", lineHeight: "1.6", whiteSpace: "pre-wrap", maxHeight: "120px", overflow: "hidden" }}>
              {s.content}
            </div>
          </div>
        ))}

        {samples.length === 0 && (
          <p style={{ color: "#aaa", fontSize: "14px" }}>No writing samples yet. Add one above or run the seed import.</p>
        )}
      </div>

      {/* ── Rules ────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "32px", marginBottom: "40px" }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>Voice Rules ({rules.length})</h2>

          <form action={addVoiceRule} style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input name="rule" placeholder="Add a rule..." required style={{ ...inputStyle, flex: 1 }} />
            <button type="submit" style={btnStyle}>Add</button>
          </form>

          {rules.map((r) => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f0ece8" }}>
              <span style={{ fontSize: "13px", color: "#444" }}>{r.rule}</span>
              <form action={removeVoiceRule}>
                <input type="hidden" name="id" value={r.id} />
                <button type="submit" style={deleteLinkStyle}>remove</button>
              </form>
            </div>
          ))}
        </div>

        {/* ── Banned Words ──────────────────────────────── */}
        <div style={{ flex: 1 }}>
          <h2 style={{ fontSize: "16px", marginBottom: "12px" }}>Banned Words ({bannedWords.length})</h2>

          <form action={addVoiceBannedWord} style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input name="word" placeholder="Add a word..." required style={{ ...inputStyle, flex: 1 }} />
            <button type="submit" style={btnStyle}>Add</button>
          </form>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {bannedWords.map((bw) => (
              <form key={bw.id} action={removeVoiceBannedWord} style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "4px 10px", borderRadius: "6px", background: "#f4f0e6", fontSize: "13px" }}>
                <input type="hidden" name="id" value={bw.id} />
                <span>{bw.word}</span>
                <button type="submit" style={{ ...deleteLinkStyle, fontSize: "11px" }}>x</button>
              </form>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e8e4df",
  borderRadius: "8px",
  padding: "16px",
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  border: "1px solid #e8e4df",
  borderRadius: "6px",
  fontSize: "14px",
  boxSizing: "border-box" as const,
};

const btnStyle: React.CSSProperties = {
  padding: "8px 20px",
  background: "#2c2c2c",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "14px",
};

const deleteLinkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "#d1242f",
  cursor: "pointer",
  fontSize: "12px",
  padding: 0,
};
