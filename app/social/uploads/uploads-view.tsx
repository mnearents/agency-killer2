import type { UploadableReel } from "@/domain/social/review-queries";
import { UploadRow } from "./upload-row";

const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function InstagramLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ color: "#6b3fb8", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
      Open on Instagram ↗
    </a>
  );
}

/** A reel still waiting for its video: cover, details, and the upload controls. */
function WaitingReel({ reel, cover }: { reel: UploadableReel; cover: string | null }) {
  return (
    <article style={{ display: "flex", gap: 16, background: "#fff", border: "1px solid #ece6df", borderRadius: 16, padding: 14, flexWrap: "wrap" }}>
      <a
        href={reel.permalink ?? undefined}
        target="_blank"
        rel="noreferrer"
        style={{
          flex: "0 0 96px", height: 120, borderRadius: 10, backgroundColor: "#efe7dd",
          backgroundImage: cover ? `url("${cover}"), linear-gradient(135deg, #f6d9c4, #d9e4f5)` : "linear-gradient(135deg, #f6d9c4, #d9e4f5)",
          backgroundSize: "cover", backgroundPosition: "center",
        }}
        aria-label="Open the reel on Instagram"
      />
      <div style={{ flex: "1 1 280px", minWidth: 0, display: "grid", gap: 8, alignContent: "start" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }}>
          <strong>{fmtDate(reel.postedAt)}</strong>
          <span style={{ color: "#5f5750", fontSize: 14 }}>{reel.views !== null ? `${reel.views.toLocaleString("en-US")} views` : "views not measured"}</span>
          <InstagramLink href={reel.permalink} />
        </div>
        <div style={{ fontSize: 15, lineHeight: 1.45, color: "#2b2622", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
          {reel.caption ?? <em>No caption</em>}
        </div>
        <UploadRow id={reel.id} done={false} />
      </div>
    </article>
  );
}

/** A reel already analysed from its upload: one quiet line, replaceable on request. */
function AnalysedReel({ reel }: { reel: UploadableReel }) {
  const u = reel.upload!;
  return (
    <li style={{ padding: "12px 0", borderTop: "1px solid #ece6df", display: "grid", gap: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }}>
        <span style={{ color: "#1f7a4d", fontWeight: 700 }}>✓</span>
        <strong>{fmtDate(reel.postedAt)}</strong>
        <span style={{ color: "#5f5750", fontSize: 14 }}>{reel.views !== null ? `${reel.views.toLocaleString("en-US")} views` : ""}</span>
        <InstagramLink href={reel.permalink} />
      </div>
      <div style={{ fontSize: 14, color: "#5f5750", lineHeight: 1.5 }}>
        {u.summary}
        {u.visualHook ? <> On screen first: “{u.visualHook}”.</> : null}
        {u.songUsed ? <> Song: {u.songUsed}.</> : null}
      </div>
      <details style={{ fontSize: 13, color: "#8a8178" }}>
        <summary style={{ cursor: "pointer" }}>Replace the upload</summary>
        <div style={{ marginTop: 8 }}>
          <UploadRow id={reel.id} done />
        </div>
      </details>
    </li>
  );
}

/** The upload page's layout, apart from its data so it can be rendered on its own. */
export function UploadsView({ reels, covers, days }: { reels: UploadableReel[]; covers: Map<string, string>; days: number }) {
  const waiting = reels.filter((r) => !r.upload);
  const analysed = reels.filter((r) => r.upload);
  return (
    <div style={{ maxWidth: 860, margin: "0 auto", color: "#2b2622" }}>
      <div style={{ fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6b3fb8", fontWeight: 700, marginTop: 12 }}>Reel uploads</div>
      <h1 style={{ fontFamily: SERIF, fontSize: "clamp(28px, 4.5vw, 38px)", margin: "10px 0 12px" }}>
        {waiting.length === 0 ? "Nothing to upload" : `${waiting.length} reel${waiting.length === 1 ? "" : "s"} need${waiting.length === 1 ? "s" : ""} the video`}
      </h1>
      {waiting.length === 0 ? (
        <p style={{ fontSize: 17, lineHeight: 1.6, color: "#5f5750", margin: "0 0 24px" }}>
          Every reel from the last {days} days has had its video looked at. When Instagram withholds a new one, it will appear here.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 17, lineHeight: 1.6, color: "#5f5750", margin: "0 0 8px" }}>
            Instagram won't share the video of reels that use licensed music, so only their cover has been seen. Open each reel, download it from Instagram
            (⋯ → Download), and upload that file here. It's fine if the download has no sound — the analysis is of what's on screen.
          </p>
          <p style={{ fontSize: 14, color: "#8a8178", margin: "0 0 24px" }}>Last {days} days. Uploads need the dashboard password.</p>
          <div style={{ display: "grid", gap: 14 }}>
            {waiting.map((r) => <WaitingReel key={r.id} reel={r} cover={covers.get(r.id) ?? r.thumbnailUrl} />)}
          </div>
        </>
      )}

      {analysed.length > 0 ? (
        <section style={{ marginTop: waiting.length > 0 ? 40 : 8 }}>
          <h2 style={{ fontFamily: SERIF, fontSize: 20, margin: "0 0 4px" }}>Already analysed ({analysed.length})</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {analysed.map((r) => <AnalysedReel key={r.id} reel={r} />)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
