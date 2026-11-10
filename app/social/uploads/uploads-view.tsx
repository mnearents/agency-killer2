import type { UploadableReel } from "@/domain/social/review-queries";
import { UploadRow } from "./upload-row";

const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

/** The upload page's layout, apart from its data so it can be rendered on its own. */
export function UploadsView({ reels, covers, days }: { reels: UploadableReel[]; covers: Map<string, string>; days: number }) {
  const waiting = reels.filter((r) => !r.upload);
  return (
    <div style={{ maxWidth: 860, margin: "0 auto", color: "#2b2622" }}>
      <div style={{ fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", color: "#6b3fb8", fontWeight: 700, marginTop: 12 }}>Reel uploads</div>
      <h1 style={{ fontFamily: SERIF, fontSize: "clamp(28px, 4.5vw, 38px)", margin: "10px 0 12px" }}>
        {waiting.length === 0 ? "Every reel has been looked at" : `${waiting.length} reel${waiting.length === 1 ? "" : "s"} need${waiting.length === 1 ? "s" : ""} the video`}
      </h1>
      <p style={{ fontSize: 17, lineHeight: 1.6, color: "#5f5750", margin: "0 0 8px" }}>
        Instagram won't share the video of reels that use licensed music, so only their cover has been seen. Open each reel, download it from Instagram
        (⋯ → Download), and upload that file here. It's fine if the download has no sound — the analysis is of what's on screen.
      </p>
      <p style={{ fontSize: 14, color: "#8a8178", margin: "0 0 24px" }}>Last {days} days. Uploads need the dashboard password.</p>

      <div style={{ display: "grid", gap: 14 }}>
        {reels.map((r) => {
          const cover = covers.get(r.id) ?? r.thumbnailUrl;
          return (
            <article key={r.id} style={{ display: "flex", gap: 16, background: "#fff", border: "1px solid #ece6df", borderRadius: 16, padding: 14, flexWrap: "wrap" }}>
              <a
                href={r.permalink ?? undefined}
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
                  <strong>{r.postedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</strong>
                  <span style={{ color: "#5f5750", fontSize: 14 }}>{r.views !== null ? `${r.views.toLocaleString("en-US")} views` : "views not measured"}</span>
                  {r.permalink ? (
                    <a href={r.permalink} target="_blank" rel="noreferrer" style={{ color: "#6b3fb8", fontWeight: 700, fontSize: 14, textDecoration: "none" }}>
                      Open on Instagram ↗
                    </a>
                  ) : null}
                  {r.upload ? <span style={{ background: "#e9f6ef", color: "#1f7a4d", borderRadius: 99, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>Analysed from upload</span> : null}
                </div>
                <div style={{ fontSize: 15, lineHeight: 1.45, color: "#2b2622", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                  {r.caption ?? <em>No caption</em>}
                </div>
                {r.upload ? (
                  <div style={{ fontSize: 14, color: "#5f5750" }}>
                    {r.upload.summary}
                    {r.upload.visualHook ? <> On screen first: “{r.upload.visualHook}”.</> : null}
                    {r.upload.songUsed ? <> Song: {r.upload.songUsed}.</> : null}
                  </div>
                ) : null}
                <UploadRow id={r.id} done={r.upload !== null} />
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
