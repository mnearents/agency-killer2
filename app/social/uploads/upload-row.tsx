"use client";

import { useState } from "react";

const MAX_BYTES = 500 * 1024 * 1024;

type State =
  | { step: "idle" }
  | { step: "uploading"; percent: number }
  | { step: "analysing" }
  | { step: "done"; visualHook: string | null; summary: string; transcribed: boolean }
  | { step: "error"; message: string };

const typeOf = (file: File) =>
  file.type || (file.name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4");

const REASONS: Record<string, string> = {
  "too-large": "That file is over 500 MB.",
  "not-a-video": "Upload an .mp4 or .mov file.",
  "not-found": "This reel isn't in the database any more.",
  "not-a-reel": "This post isn't a reel.",
  "unreadable-video": "That file couldn't be read as a video.",
  "analysis-failed": "The video was received but couldn't be analysed. Try again in a minute.",
};

/** One reel's upload: choose the file Instagram's download gave you, name the song, send. */
export function UploadRow({ id, done }: { id: string; done: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [song, setSong] = useState("");
  const [state, setState] = useState<State>({ step: "idle" });

  async function send() {
    if (!file) return;
    if (!/\.(mp4|mov)$/i.test(file.name)) return setState({ step: "error", message: REASONS["not-a-video"] });
    if (file.size > MAX_BYTES) return setState({ step: "error", message: REASONS["too-large"] });

    // Asked first so the browser prompts for the password before the file is sent.
    const check = await fetch("/api/social/upload", { credentials: "same-origin" });
    if (!check.ok) return setState({ step: "error", message: check.status === 503 ? "Uploads aren't set up on this dashboard." : "The password wasn't accepted." });

    setState({ step: "uploading", percent: 0 });
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/social/upload/${id}?song=${encodeURIComponent(song.trim())}`);
    xhr.setRequestHeader("content-type", typeOf(file));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setState({ step: "uploading", percent: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.upload.onload = () => setState({ step: "analysing" });
    xhr.onerror = () => setState({ step: "error", message: "The upload was interrupted. Try again." });
    xhr.onload = () => {
      let body: { ok?: boolean; reason?: string; visualHook?: string | null; summary?: string; transcribed?: boolean } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Not JSON: reported below by status.
      }
      if (xhr.status === 200 && body.ok) {
        setState({ step: "done", visualHook: body.visualHook ?? null, summary: body.summary ?? "", transcribed: body.transcribed === true });
      } else {
        setState({ step: "error", message: REASONS[body.reason ?? ""] ?? `Upload failed (${xhr.status}).` });
      }
    };
    xhr.send(file);
  }

  const busy = state.step === "uploading" || state.step === "analysing";
  const input = { padding: "8px 10px", border: "1px solid #ddd5cc", borderRadius: 8, fontSize: 14, background: "#fff" } as const;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <input type="file" accept=".mp4,.mov,video/mp4,video/quicktime" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ fontSize: 14, maxWidth: "100%" }} />
        <input type="text" placeholder="Song used (optional)" value={song} disabled={busy} onChange={(e) => setSong(e.target.value)} maxLength={200} style={{ ...input, flex: "1 1 180px", minWidth: 0 }} />
        <button
          onClick={send}
          disabled={!file || busy}
          style={{ padding: "9px 16px", borderRadius: 99, border: "none", background: !file || busy ? "#cfc6bd" : "#6b3fb8", color: "#fff", fontWeight: 700, fontSize: 14, cursor: !file || busy ? "default" : "pointer" }}
        >
          {done ? "Upload again" : "Upload"}
        </button>
      </div>
      {state.step === "uploading" ? (
        <div style={{ height: 8, background: "#efe9e3", borderRadius: 99, overflow: "hidden" }}>
          <div style={{ width: `${state.percent}%`, height: "100%", background: "#6b3fb8", transition: "width 0.2s" }} />
        </div>
      ) : null}
      {state.step === "analysing" ? <div style={{ fontSize: 14, color: "#5f5750" }}>Uploaded. Looking at the frames — this takes about a minute…</div> : null}
      {state.step === "done" ? (
        <div style={{ fontSize: 14, color: "#1f7a4d" }}>
          <strong>Analysed.</strong> {state.summary}
          {state.visualHook ? <> On screen first: “{state.visualHook}”.</> : null}
          {state.transcribed ? " Speech transcribed." : ""}
        </div>
      ) : null}
      {state.step === "error" ? <div style={{ fontSize: 14, color: "#b3372f" }}>{state.message}</div> : null}
    </div>
  );
}
