import type { UploadableReel } from "@/domain/social/review-queries";
import type { PeerPost, PeerPostScore } from "@/domain/social/peers";
import { UploadRow } from "./upload-row";

export type PeerReel = PeerPost & PeerPostScore;
export interface PeerUploads {
  waiting: PeerReel[];
  uploaded: PeerReel[];
}

/** How many peer reels show before the rest fold away. */
const PEER_SHOWN = 8;

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

function vsUsualText(r: PeerReel): string {
  if (r.vsUsual !== null) return `${r.vsUsual}× their usual`;
  if (r.verdict === "settling") return "too new to judge";
  if (r.verdict === "not-measured") return "views not shared";
  return "not enough history to judge";
}

/** A peer reel seen by its cover only: what it did for them, and the upload controls. */
function WaitingPeerReel({ reel }: { reel: PeerReel }) {
  const standout = reel.verdict === "breakout" || reel.verdict === "above";
  return (
    <article style={{ display: "flex", gap: 16, background: "#fff", border: "1px solid #ece6df", borderRadius: 16, padding: 14, flexWrap: "wrap" }}>
      <a
        href={reel.permalink ?? undefined}
        target="_blank"
        rel="noreferrer"
        style={{
          flex: "0 0 96px", height: 120, borderRadius: 10, backgroundColor: "#efe7dd",
          backgroundImage: reel.thumbnailUrl ? `url("${reel.thumbnailUrl}"), linear-gradient(135deg, #f6d9c4, #d9e4f5)` : "linear-gradient(135deg, #f6d9c4, #d9e4f5)",
          backgroundSize: "cover", backgroundPosition: "center",
        }}
        aria-label="Open the reel on Instagram"
      />
      <div style={{ flex: "1 1 280px", minWidth: 0, display: "grid", gap: 8, alignContent: "start" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }}>
          <strong>@{reel.username}</strong>
          <span style={{ color: "#5f5750", fontSize: 14 }}>{fmtDate(reel.postedAt)}</span>
          <span style={{ color: "#5f5750", fontSize: 14 }}>{reel.viewCount !== null ? `${reel.viewCount.toLocaleString("en-US")} views` : ""}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: standout ? "#1f7a4d" : "#8a8178" }}>{vsUsualText(reel)}</span>
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

/** A peer reel already uploaded: one line. */
function UploadedPeerReel({ reel }: { reel: PeerReel }) {
  return (
    <li style={{ padding: "12px 0", borderTop: "1px solid #ece6df", display: "grid", gap: 4 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }}>
        <span style={{ color: "#1f7a4d", fontWeight: 700 }}>✓</span>
        <strong>@{reel.username}</strong>
        <span style={{ color: "#5f5750", fontSize: 14 }}>{fmtDate(reel.postedAt)} · {vsUsualText(reel)}</span>
        <InstagramLink href={reel.permalink} />
      </div>
      <div style={{ fontSize: 14, color: "#5f5750", lineHeight: 1.5 }}>
        {reel.visual?.summary}
        {reel.visual?.visualHook ? <> On screen first: “{reel.visual.visualHook}”.</> : null}
        {reel.openingWords ? <> First words: “{reel.openingWords}”</> : null}
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

function PeerSection({ peers }: { peers: PeerUploads }) {
  if (peers.waiting.length === 0 && peers.uploaded.length === 0) return null;
  const shown = peers.waiting.slice(0, PEER_SHOWN);
  const rest = peers.waiting.slice(PEER_SHOWN);
  return (
    <section style={{ marginTop: 40 }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 24, margin: "0 0 8px" }}>Peer reels</h2>
      <p style={{ fontSize: 16, lineHeight: 1.6, color: "#5f5750", margin: "0 0 8px" }}>
        Instagram never shares another account's video, so these have only been seen by their cover. Upload a copy of any worth a closer look and
        it gets the same frames, pacing and transcript as Tara's — the ones that did best for them are first. Instagram only offers Download when the
        creator allows it; a screen recording works otherwise.
      </p>
      <p style={{ fontSize: 14, color: "#8a8178", margin: "0 0 20px" }}>Optional. Last 30 days.</p>
      <div style={{ display: "grid", gap: 14 }}>
        {shown.map((r) => <WaitingPeerReel key={r.id} reel={r} />)}
      </div>
      {rest.length > 0 ? (
        <details style={{ marginTop: 14 }}>
          <summary style={{ cursor: "pointer", fontSize: 15, color: "#6b3fb8", fontWeight: 700 }}>Show {rest.length} more</summary>
          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            {rest.map((r) => <WaitingPeerReel key={r.id} reel={r} />)}
          </div>
        </details>
      ) : null}
      {peers.uploaded.length > 0 ? (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontFamily: SERIF, fontSize: 18, margin: "0 0 4px" }}>Peer reels already analysed ({peers.uploaded.length})</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {peers.uploaded.map((r) => <UploadedPeerReel key={r.id} reel={r} />)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** The upload page's layout, apart from its data so it can be rendered on its own. */
export function UploadsView({ reels, covers, days, peers }: { reels: UploadableReel[]; covers: Map<string, string>; days: number; peers?: PeerUploads }) {
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

      {peers ? <PeerSection peers={peers} /> : null}
    </div>
  );
}
