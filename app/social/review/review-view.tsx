import type { ReactNode } from "react";
import type { Db } from "@/db/client";
import { getAccountDayRows, getReviewPosts, getTargets, listReviews, type SocialReview } from "@/domain/social/review-queries";
import { buildBaselines, buildScorecard, scorePost, summariseAccountDays, BASELINE_DAYS, type AccountSummary, type ScorecardRow, type Verdict } from "@/domain/social/review";
import { parseReviewText, type Block, type TextPart } from "@/lib/review-text";

/**
 * The weekly organic Instagram review, as Tara reads it: Claude's words,
 * with the week's numbers and posts read live from the database beside them.
 */

const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export async function loadReviewPage(db: Db, review: SocialReview, now: Date) {
  const since = new Date(Math.min(Date.parse(`${review.weekStart}T00:00:00Z`), now.getTime()) - BASELINE_DAYS * 86_400_000);
  const [posts, days, archive, targets, allDays] = await Promise.all([
    getReviewPosts(db, since),
    getAccountDayRows(db, shiftDay(review.weekStart, -7), review.weekEnd),
    listReviews(db),
    getTargets(db),
    getAccountDayRows(db, "2000-01-01", review.weekEnd),
  ]);
  // Judged against her usual as it stood at the end of that week, so an old
  // review's posts keep the verdicts they were written about.
  const asOf = new Date(Math.min(now.getTime(), Date.parse(`${review.weekEnd}T23:59:59Z`) + 2 * 86_400_000));
  const baselines = buildBaselines(posts.filter((p) => p.postedAt <= asOf), asOf);
  const weekPosts = posts
    .filter((p) => { const d = p.postedAt.toISOString().slice(0, 10); return d >= review.weekStart && d <= review.weekEnd; })
    .map((p) => ({ post: p, score: scorePost(p, baselines, now) }))
    .sort((a, b) => (b.score.vsUsual[b.score.judgedOn ?? "views"] ?? -1) - (a.score.vsUsual[a.score.judgedOn ?? "views"] ?? -1));
  return {
    scorecard: buildScorecard({
      readings: allDays,
      targets,
      weekEnd: review.weekEnd,
      postsInWeek: { all: weekPosts.length, reels: weekPosts.filter((w) => w.post.format === "reel").length },
    }),
    thisWeek: summariseAccountDays(days, review.weekStart, review.weekEnd),
    lastWeek: summariseAccountDays(days, shiftDay(review.weekStart, -7), shiftDay(review.weekStart, -1)),
    weekPosts,
    archive,
  };
}

type PageData = Awaited<ReturnType<typeof loadReviewPage>>;

const C = {
  ink: "#2b2622",
  soft: "#5f5750",
  faint: "#8a8178",
  line: "#ece6df",
  card: "#ffffff",
  green: "#1f7a4d",
  greenBg: "#e9f6ef",
  amber: "#a2650a",
  amberBg: "#fdf3e1",
  blue: "#2459a8",
  blueBg: "#eaf1fb",
  violet: "#6b3fb8",
  violetBg: "#f2ecfb",
  red: "#b3372f",
};
const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

function fmtWeek(start: string, end: string): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const sameMonth = month(s) === month(e);
  return `${month(s)} ${s.getUTCDate()} – ${sameMonth ? "" : `${month(e)} `}${e.getUTCDate()}, ${e.getUTCFullYear()}`;
}

const num = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));

function Parts({ parts }: { parts: TextPart[] }) {
  return <>{parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : p.italic ? <em key={i}>{p.text}</em> : <span key={i}>{p.text}</span>))}</>;
}

function Prose({ text, size = 17 }: { text: string; size?: number }) {
  const blocks: Block[] = parseReviewText(text);
  const base = { fontSize: size, lineHeight: 1.65, color: C.ink, margin: "0 0 14px" };
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === "p") return <p key={i} style={base}><Parts parts={b.parts} /></p>;
        const List = b.type === "ul" ? "ul" : "ol";
        return (
          <List key={i} style={{ ...base, paddingLeft: 22 }}>
            {b.items.map((item, j) => <li key={j} style={{ marginBottom: 8 }}><Parts parts={item} /></li>)}
          </List>
        );
      })}
    </>
  );
}

function Delta({ now, before, suffix = "" }: { now: number | null; before: number | null; suffix?: string }) {
  if (now === null || before === null) return null;
  const diff = now - before;
  if (diff === 0) return <span style={{ color: C.faint, fontSize: 13 }}>same as last week</span>;
  const up = diff > 0;
  return (
    <span style={{ color: up ? C.green : C.red, fontSize: 13, fontWeight: 600 }}>
      {up ? "▲" : "▼"} {Math.abs(Math.round(diff * 10) / 10).toLocaleString("en-US")}{suffix} vs last week
    </span>
  );
}

function Stat({ label, value, sub, delta }: { label: string; value: string; sub?: string; delta?: ReactNode }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: C.faint, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 700, color: C.ink, margin: "6px 0 4px", fontFamily: SERIF }}>{value}</div>
      {sub ? <div style={{ fontSize: 13, color: C.soft, marginBottom: 4 }}>{sub}</div> : null}
      {delta}
    </div>
  );
}

function share(s: AccountSummary) {
  return s.nonFollowerReachShare === null ? null : Math.round(s.nonFollowerReachShare * 1000) / 10;
}

function Numbers({ data }: { data: PageData }) {
  const { thisWeek: w, lastWeek: l } = data;
  const net = w.net === null ? "—" : `${w.net > 0 ? "+" : ""}${w.net.toLocaleString("en-US")}`;
  return (
    <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, margin: "28px 0 8px" }}>
      <Stat
        label="New followers, net"
        value={net}
        sub={w.follows !== null ? `${num(w.follows)} followed · ${num(w.unfollows)} left` : undefined}
        delta={<Delta now={w.net} before={l.net} />}
      />
      <Stat
        label="Reach to new people"
        value={share(w) === null ? "—" : `${share(w)}%`}
        sub="of everyone reached wasn't following yet"
        delta={<Delta now={share(w)} before={share(l)} suffix=" pts" />}
      />
      <Stat label="Organic views" value={num(w.organicViews)} sub="reels, posts and stories — not ads" delta={<Delta now={w.organicViews} before={l.organicViews} />} />
      <Stat label="Profile visits" value={num(w.profileViews)} delta={<Delta now={w.profileViews} before={l.profileViews} />} />
      {w.daysMeasured < w.daysInRange ? (
        <div style={{ gridColumn: "1 / -1", fontSize: 13, color: C.faint }}>
          Instagram's account numbers are held for {w.daysMeasured} of this week's {w.daysInRange} days, so these totals are partial.
        </div>
      ) : null}
    </section>
  );
}

const MEASURE_LABEL: Record<ScorecardRow["measure"], string> = {
  followers: "Followers",
  posts_per_week: "Posts this week",
  reels_per_week: "Reels this week",
};
const STATUS: Record<ScorecardRow["status"], { label: string; color: string; bg: string }> = {
  ahead: { label: "Ahead", color: C.green, bg: C.greenBg },
  "on-track": { label: "On track", color: C.green, bg: C.greenBg },
  behind: { label: "Behind", color: C.amber, bg: C.amberBg },
  "no-target": { label: "No target set", color: C.faint, bg: "#f3f0ec" },
  "not-enough-history": { label: "Pace starts next week", color: C.faint, bg: "#f3f0ec" },
};

function Scorecard({ rows }: { rows: ScorecardRow[] }) {
  if (rows.every((r) => r.status === "no-target")) return null;
  return (
    <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "18px 22px", margin: "8px 0 18px" }}>
      <div style={{ fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", color: C.faint, fontWeight: 600, marginBottom: 10 }}>Scorecard</div>
      <div style={{ display: "grid", gap: 10 }}>
        {rows.map((r) => {
          const st = STATUS[r.status];
          return (
            <div key={r.measure} style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 14px" }}>
              <span style={{ minWidth: 130, fontWeight: 600, color: C.ink }}>{MEASURE_LABEL[r.measure]}</span>
              <span style={{ fontFamily: SERIF, fontSize: 20, color: C.ink }}>
                {num(r.actual)}{r.target !== null ? <span style={{ color: C.faint, fontSize: 15 }}> of {num(r.target)}{r.measure === "followers" ? " on pace" : ""}</span> : null}
              </span>
              <span style={{ background: st.bg, color: st.color, borderRadius: 99, padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>{st.label}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const TRIED: Record<string, { label: string; color: string; bg: string }> = {
  yes: { label: "Tried", color: C.green, bg: C.greenBg },
  partly: { label: "Partly", color: C.blue, bg: C.blueBg },
  no: { label: "Not yet", color: C.amber, bg: C.amberBg },
  unknown: { label: "Can't tell", color: C.faint, bg: "#f3f0ec" },
};

function IdeasTried({ rows }: { rows: NonNullable<SocialReview["ideasTried"]> }) {
  return (
    <Section title="Last week's ideas" color={C.violet} bg={C.violetBg}>
      <div style={{ display: "grid", gap: 12 }}>
        {rows.map((r, i) => {
          const t = TRIED[r.tried] ?? TRIED.unknown;
          return (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span style={{ flex: "0 0 auto", background: t.bg, color: t.color, borderRadius: 99, padding: "3px 10px", fontSize: 12, fontWeight: 700, marginTop: 2 }}>{t.label}</span>
              <div style={{ fontSize: 16, lineHeight: 1.55, color: C.ink }}>
                <strong>{r.idea}</strong>
                {r.result ? <div style={{ color: C.soft }}>{r.result}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const FORMAT_TAG: Record<string, string> = { reel: "Reel", carousel: "Carousel", image: "Photo", story: "Story", video: "Video", live: "Live" };

function Plan({ rows }: { rows: NonNullable<SocialReview["plan"]> }) {
  return (
    <section style={{ margin: "28px 0" }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 24, color: C.ink, margin: "0 0 14px" }}>The week ahead</h2>
      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, overflow: "hidden" }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", alignItems: "baseline", padding: "14px 18px", borderTop: i === 0 ? "none" : `1px solid ${C.line}` }}>
            <span style={{ width: 92, fontWeight: 700, color: C.ink }}>{r.day}</span>
            <span style={{ background: "#f3f0ec", borderRadius: 99, padding: "2px 10px", fontSize: 12, fontWeight: 600, color: C.soft }}>{FORMAT_TAG[r.format] ?? r.format}</span>
            <span style={{ flex: "1 1 260px", fontSize: 16, lineHeight: 1.5, color: C.ink }}>{r.idea}</span>
            {r.keyword ? <span style={{ fontSize: 13, color: C.violet, fontWeight: 700 }}>Comment “{r.keyword}”</span> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function Section({ title, color, bg, children }: { title: string; color: string; bg: string; children: ReactNode }) {
  return (
    <section style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, padding: "24px 28px", margin: "18px 0" }}>
      <h2 style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 14px", fontSize: 20, color: C.ink, fontFamily: SERIF }}>
        <span style={{ width: 12, height: 12, borderRadius: 99, background: color, boxShadow: `0 0 0 5px ${bg}` }} />
        {title}
      </h2>
      {children}
    </section>
  );
}

function TryNext({ text }: { text: string }) {
  const blocks = parseReviewText(text);
  const items = blocks.flatMap((b) => (b.type === "p" ? [b.parts] : b.items));
  return (
    <section style={{ margin: "28px 0" }}>
      <h2 style={{ fontFamily: SERIF, fontSize: 24, color: C.ink, margin: "0 0 14px" }}>Try this week</h2>
      <div style={{ display: "grid", gap: 12 }}>
        {items.map((parts, i) => (
          <div key={i} style={{ display: "flex", gap: 16, alignItems: "flex-start", background: C.violetBg, borderRadius: 16, padding: "18px 22px" }}>
            <span style={{ flex: "0 0 auto", width: 34, height: 34, borderRadius: 99, background: C.violet, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontFamily: SERIF, fontSize: 17 }}>
              {i + 1}
            </span>
            <div style={{ fontSize: 17, lineHeight: 1.6, color: C.ink, paddingTop: 4 }}><Parts parts={parts} /></div>
          </div>
        ))}
      </div>
    </section>
  );
}

const VERDICT: Record<Verdict, { label: (x: number | null) => string; color: string; bg: string }> = {
  breakout: { label: (x) => `Breakout · ${x}× your usual`, color: C.green, bg: C.greenBg },
  above: { label: (x) => `Above usual · ${x}×`, color: C.green, bg: C.greenBg },
  typical: { label: () => "About usual", color: C.blue, bg: C.blueBg },
  below: { label: (x) => `Below usual · ${x}×`, color: C.amber, bg: C.amberBg },
  settling: { label: () => "Still settling", color: C.faint, bg: "#f3f0ec" },
  "not-enough-history": { label: () => "Building a baseline", color: C.faint, bg: "#f3f0ec" },
  "not-measured": { label: () => "Not measured", color: C.faint, bg: "#f3f0ec" },
};

const FORMAT_LABEL: Record<string, string> = { reel: "Reel", carousel: "Carousel", image: "Photo", video: "Video", story: "Story" };

function PostCard({ item }: { item: PageData["weekPosts"][number] }) {
  const { post, score } = item;
  const v = VERDICT[score.verdict];
  const raw = score.judgedOn ? score.vsUsual[score.judgedOn] : null;
  const ratio = raw === null ? null : Math.round(raw * 10) / 10;
  const hook = post.analysis?.hook ?? post.openingWords ?? post.caption?.split("\n")[0] ?? "";
  const day = post.postedAt.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  // Our own copy of a reel's frames does not expire; Instagram's cover does.
  const sheet = post.visual?.hasContactSheet ? `/api/social/sheet/${post.id}` : null;
  const picture = sheet ?? post.thumbnailUrl;
  return (
    <article style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          aspectRatio: "4 / 5",
          backgroundColor: "#efe7dd",
          backgroundImage: picture ? `url("${picture}"), linear-gradient(135deg, #f6d9c4, #d9e4f5)` : "linear-gradient(135deg, #f6d9c4, #d9e4f5)",
          backgroundSize: sheet ? "contain" : "cover",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
          position: "relative",
        }}
      >
        <span style={{ position: "absolute", top: 10, left: 10, background: "rgba(255,255,255,0.92)", borderRadius: 99, padding: "3px 10px", fontSize: 12, fontWeight: 600, color: C.ink }}>
          {FORMAT_LABEL[post.format] ?? post.format} · {day}
        </span>
      </div>
      <div style={{ padding: "14px 16px 16px", display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
        <span style={{ alignSelf: "flex-start", background: v.bg, color: v.color, borderRadius: 99, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>{v.label(ratio)}</span>
        {hook ? (
          <p style={{ margin: 0, fontFamily: SERIF, fontStyle: "italic", fontSize: 15, lineHeight: 1.45, color: C.ink, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            “{hook}”
          </p>
        ) : null}
        <div style={{ fontSize: 13, color: C.soft, display: "flex", flexWrap: "wrap", gap: "4px 12px", marginTop: "auto" }}>
          {post.views !== null ? <span>{num(post.views)} views</span> : <span>{num(post.reach)} reached</span>}
          {post.views !== null ? <span>{num(post.shares)} shares</span> : null}
          <span>{num(post.saved)} saves</span>
          {post.follows !== null ? <span>{num(post.follows)} follows</span> : null}
        </div>
        {post.visual?.visualHook ? (
          <div style={{ fontSize: 13, color: C.soft }}>
            <span style={{ fontWeight: 700, color: C.ink }}>On screen: </span>“{post.visual.visualHook}”
          </div>
        ) : null}
        {post.permalink ? (
          <a href={post.permalink} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: C.violet, fontWeight: 600, textDecoration: "none" }}>
            Open on Instagram →
          </a>
        ) : null}
      </div>
    </article>
  );
}

export function ReviewView({ review, data }: { review: SocialReview; data: PageData }) {
  return (
    <div style={{ maxWidth: 980, margin: "0 auto", color: C.ink }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div style={{ fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", color: C.violet, fontWeight: 700, marginTop: 12 }}>
          Weekly Instagram review · {fmtWeek(review.weekStart, review.weekEnd)}
        </div>
        <h1 style={{ fontFamily: SERIF, fontSize: "clamp(30px, 5vw, 44px)", lineHeight: 1.15, margin: "12px 0 18px", color: C.ink }}>{review.headline}</h1>
        <Prose text={review.summary} size={19} />
        <Numbers data={data} />
        <Scorecard rows={data.scorecard} />
        {review.ideasTried && review.ideasTried.length > 0 ? <IdeasTried rows={review.ideasTried} /> : null}
        <Section title="What's working" color={C.green} bg={C.greenBg}><Prose text={review.working} /></Section>
        <Section title="What isn't landing yet" color={C.amber} bg={C.amberBg}><Prose text={review.notWorking} /></Section>
        <Section title="Why" color={C.blue} bg={C.blueBg}><Prose text={review.why} /></Section>
        <TryNext text={review.tryNext} />
        {review.plan && review.plan.length > 0 ? <Plan rows={review.plan} /> : null}
        {review.fromPeers ? (
          <Section title="Ideas from around the niche" color="#c2477a" bg="#fbeaf1"><Prose text={review.fromPeers} /></Section>
        ) : null}
      </div>

      {data.weekPosts.length > 0 ? (
        <section style={{ margin: "40px 0 24px" }}>
          <h2 style={{ fontFamily: SERIF, fontSize: 24, margin: "0 0 4px" }}>This week's posts</h2>
          <p style={{ margin: "0 0 16px", color: C.soft, fontSize: 15 }}>Each one next to your own usual for that kind of post — not anyone else's.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(210px, 40vw), 1fr))", gap: 14 }}>
            {data.weekPosts.map((item) => <PostCard key={item.post.id} item={item} />)}
          </div>
        </section>
      ) : null}

      {data.archive.length > 1 ? (
        <section style={{ maxWidth: 760, margin: "40px auto 24px", borderTop: `1px solid ${C.line}`, paddingTop: 20 }}>
          <h2 style={{ fontFamily: SERIF, fontSize: 20, margin: "0 0 10px" }}>Earlier reviews</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {data.archive.filter((a) => a.weekStart !== review.weekStart).map((a) => (
              <li key={a.id} style={{ padding: "8px 0", borderBottom: `1px solid ${C.line}` }}>
                <a href={`/social/review/${a.id}`} style={{ color: C.ink, textDecoration: "none" }}>
                  <span style={{ color: C.faint, fontSize: 13, marginRight: 12 }}>{fmtWeek(a.weekStart, a.weekEnd)}</span>
                  {a.headline}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function NoReview() {
  return (
    <div style={{ maxWidth: 640, margin: "60px auto", textAlign: "center", color: C.soft }}>
      <h1 style={{ fontFamily: SERIF, color: C.ink }}>No review yet</h1>
      <p style={{ fontSize: 17, lineHeight: 1.6 }}>
        Each week Claude reads the Instagram numbers and writes what worked, what didn't, why, and what to try next. The first one will appear here.
      </p>
    </div>
  );
}
