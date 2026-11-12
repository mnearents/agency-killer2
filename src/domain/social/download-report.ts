/**
 * What a run of reel downloads found, in words — for the `!sync reels` reply
 * and the worker log: per reel, what the frames showed and, for a teacher's,
 * the transcript and the advice read from it.
 */

import { inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import { socialLessons, socialPeerPosts, socialPostVisuals } from "@/db/schema";
import type { ReelDownloadRun } from "./reel-backfill";

const who = (r: { account: string; username: string | null }) => (r.account === "own" ? "Tara" : `@${r.username} (${r.account})`);
const yesNo = (v: number | null) => (v === null ? "can't tell" : v === 1 ? "yes" : "no");

export async function describeDownloadRun(db: Db, run: ReelDownloadRun, opts: { transcriptChars: number }): Promise<string[]> {
  const ids = run.results.filter((r) => r.outcome === "ok").map((r) => r.postId);
  const [visuals, peerPosts, lessons] = ids.length === 0 ? [[], [], []] : await Promise.all([
    db.select().from(socialPostVisuals).where(inArray(socialPostVisuals.postId, ids)),
    db.select({ id: socialPeerPosts.id, transcript: socialPeerPosts.transcript, openingWords: socialPeerPosts.openingWords }).from(socialPeerPosts).where(inArray(socialPeerPosts.id, ids)),
    db.select().from(socialLessons).where(inArray(socialLessons.postId, ids)),
  ]);

  const lines = [
    `${run.calls} download call(s): ${run.ok} analysed, ${run.failed} failed` +
      (run.stopped ? ` — stopped: ${run.stopped}` : "") +
      (run.deferred.teacher + run.deferred.peer + run.deferred.own > 0 ? ` — still queued: Tara ${run.deferred.own}, teachers ${run.deferred.teacher}, peers ${run.deferred.peer}` : ""),
  ];
  for (const r of run.results) {
    lines.push("", `${who(r)} — ${r.permalink}`);
    if (r.outcome !== "ok") {
      lines.push(`  ${r.outcome}${r.detail ? `: ${r.detail}` : ""}`);
      continue;
    }
    const v = visuals.find((x) => x.postId === r.postId);
    if (v) {
      lines.push(
        `  Shows: ${v.summary ?? "(no summary)"}`,
        `  On screen first: ${v.visualHook ? `"${v.visualHook}"` : "none"} · face in first 2s: ${yesNo(v.faceInFirst2s)} · ` +
          `${v.cutsPerMinute ?? "?"} cuts/min · ${v.durationMs ? `${Math.round(v.durationMs / 1000)}s` : "length unknown"} · sound: ${v.audio ?? "unknown"}`,
      );
    }
    const p = peerPosts.find((x) => x.id === r.postId);
    if (p) {
      lines.push(`  First words: ${p.openingWords ? `"${p.openingWords}"` : "none"}`);
      if (p.transcript) {
        const t = p.transcript.length > opts.transcriptChars ? `${p.transcript.slice(0, opts.transcriptChars)}…` : p.transcript;
        lines.push(`  Transcript: ${t}`);
      }
    } else if (r.transcribed) {
      lines.push("  Speech transcribed.");
    }
    const advice = lessons.filter((l) => l.postId === r.postId);
    if (r.account === "teacher") {
      lines.push(advice.length === 0 ? "  Advice: none read yet" : "  Advice:");
      for (const a of advice) lines.push(`   • [${a.area}, ${a.kind}] ${a.principle}${a.quote ? ` — "${a.quote}"` : ""}`);
    }
  }
  return lines;
}
