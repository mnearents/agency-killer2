/**
 * Drafts — where Claude's copy work lives, and the fold that turns a draft
 * plus its decisions into a readable record.
 *
 * ## The boundary
 *
 * **Claude writes drafts. Claude never publishes.** Approval happens outside
 * this system and gets *recorded* here. `status` is the trace of a human
 * decision, not a workflow that produces one: nothing here can move a draft to
 * `shipped` on its own, and nothing downstream treats `approved` as
 * authorisation to send. Attentive, Meta and Shopify stay strictly read-only.
 *
 * This is stated plainly because a status enum containing `shipped` reads like
 * the beginning of a publishing pipeline, and the next person to touch it will
 * reasonably assume that was the intent. It was not.
 *
 * ## Why decisions are an append-only log
 *
 * Feedback is the valuable part. Tara is the CEO, the creative director, and
 * the voice being replicated — her rejections are the highest-signal training
 * data available, because a rejected draft plus the reason marks a boundary the
 * model crossed. The natural pull is to record why something was approved and
 * let rejections quietly disappear, which inverts the value.
 *
 * A mutable `status` column would do exactly that: Tara rejects with a reason,
 * Claude rewrites, Tara approves, and the rejection is overwritten at the
 * precise moment it became useful. A log cannot lose it. Feedback is stored
 * verbatim — a summarised reason loses the phrasing, and the phrasing is the
 * point when the subject is voice.
 *
 * Pure functions only — no database, no clock. The caller supplies both.
 */

import { isRuleAudience, type RuleAudience } from "@/domain/voice/rules";

export const DRAFT_TYPES = [
  "campaign_brief",
  "ad_copy",
  "email",
  "sms",
  "social_caption",
  "product_description",
  "blog_post",
] as const;
export type DraftType = (typeof DRAFT_TYPES)[number];

/** The decisions a person can record. `draft` is the absence of one. */
export const DECISIONS = ["approved", "rejected", "shipped"] as const;
export type Decision = (typeof DECISIONS)[number];

export type DraftStatus = Decision | "draft";

export interface DraftRecord {
  id: string;
  type: DraftType;
  title: string;
  /**
   * The voice audience this copy was written for, reused from `rules.ts`
   * rather than redeclared — the draft has to be checked against the rules for
   * the channel it is actually for. A campaign brief nobody publishes is
   * `unspecified`, which is excused from nothing.
   */
  channel: RuleAudience;
  body: string;
  author: string;
  createdAt: Date;
}

export interface DraftDecisionEntry {
  id: string;
  draftId: string;
  decision: Decision;
  /** Verbatim. Required on a rejection, which is the case that matters. */
  feedback: string;
  /** A person. Never an agent — see `isAgentAttribution`. */
  decidedBy: string;
  createdAt: Date;
}

export interface Draft extends DraftRecord {
  status: DraftStatus;
  /** Every decision, oldest first. Nothing is overwritten. */
  decisions: DraftDecisionEntry[];
  /** Just the feedback, oldest first — the training signal, in order. */
  feedbackHistory: string[];
  lastActivityAt: Date;
}

export interface FoldedDrafts {
  drafts: Draft[];
  /** Decisions whose draft does not exist. Data damage, surfaced not dropped. */
  orphanedDecisions: DraftDecisionEntry[];
}

const MAX_BODY_LENGTH = 50_000;
const MAX_TITLE_LENGTH = 200;

export type ValidationResult = { ok: true } | { ok: false; error: string };

function requireText(value: unknown, field: string, max: number): ValidationResult {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") return { ok: false, error: `"${field}" is required and cannot be empty` };
  if (text.length > max) {
    return { ok: false, error: `"${field}" is too long (${text.length} > ${max} characters)` };
  }
  return { ok: true };
}

export function validateDraft(draft: DraftRecord): ValidationResult {
  for (const [field, max] of [
    ["title", MAX_TITLE_LENGTH],
    ["body", MAX_BODY_LENGTH],
    ["author", MAX_TITLE_LENGTH],
  ] as const) {
    const check = requireText(draft[field], field, max);
    if (!check.ok) return check;
  }

  if (!(DRAFT_TYPES as readonly string[]).includes(draft.type)) {
    return { ok: false, error: `"type" must be one of: ${DRAFT_TYPES.join(", ")}` };
  }

  if (!isRuleAudience(draft.channel)) {
    return {
      ok: false,
      error:
        `"channel" must be a voice audience, so the draft can be checked against ` +
        `the rules that apply to it. Use "unspecified" for copy with no channel.`,
    };
  }

  return { ok: true };
}

/**
 * Names that mean "this system", not "a person".
 *
 * The realistic failure is not Claude impersonating Tara. It is Claude
 * defaulting `decidedBy` the way every other write tool defaults `author`, and
 * a draft quietly reaching `approved` with no human in the loop — the boundary
 * this module exists to hold. Refusing an agent attribution costs nothing and
 * closes the accidental case.
 */
const AGENT_NAMES = new Set(["claude", "agent", "system", "assistant", "ai", "bot", "worker"]);

export function isAgentAttribution(name: string): boolean {
  return AGENT_NAMES.has(name.trim().toLowerCase());
}

export function validateDecision(entry: DraftDecisionEntry): ValidationResult {
  const draftId = requireText(entry.draftId, "draftId", MAX_TITLE_LENGTH);
  if (!draftId.ok) return draftId;

  if (!(DECISIONS as readonly string[]).includes(entry.decision)) {
    return {
      ok: false,
      error:
        `"decision" must be one of: ${DECISIONS.join(", ")}. ` +
        `"draft" is the absence of a decision, not one you can record.`,
    };
  }

  const decidedBy = requireText(entry.decidedBy, "decidedBy", MAX_TITLE_LENGTH);
  if (!decidedBy.ok) return decidedBy;

  if (isAgentAttribution(entry.decidedBy)) {
    return {
      ok: false,
      error:
        `"decidedBy" must name the person who made this call. Approving, rejecting ` +
        `and shipping are human decisions that this tool records — it does not make ` +
        `them, and a draft must never reach "${entry.decision}" without a person behind it.`,
    };
  }

  // A rejection without a reason is the case this column exists for, and the
  // one most likely to be skipped. An approval can stand on its own.
  if (entry.decision === "rejected") {
    const feedback = requireText(entry.feedback, "feedback", MAX_BODY_LENGTH);
    if (!feedback.ok) {
      return {
        ok: false,
        error:
          `"feedback" is required on a rejection. A rejected draft plus the reason is ` +
          `the highest-signal record in this system — it marks a boundary the model ` +
          `crossed, and without the reason it marks nothing.`,
      };
    }
  }

  return { ok: true };
}

// ─── Folding ──────────────────────────────────────────────────────────

function byTimeThenId(a: DraftDecisionEntry, b: DraftDecisionEntry): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

export function foldDrafts(
  drafts: DraftRecord[],
  decisions: DraftDecisionEntry[]
): FoldedDrafts {
  const known = new Map(drafts.map((d) => [d.id, d]));
  const byDraft = new Map<string, DraftDecisionEntry[]>();
  const orphanedDecisions: DraftDecisionEntry[] = [];

  for (const d of decisions) {
    if (!known.has(d.draftId)) {
      orphanedDecisions.push(d);
      continue;
    }
    const list = byDraft.get(d.draftId);
    if (list) list.push(d);
    else byDraft.set(d.draftId, [d]);
  }

  const folded: Draft[] = drafts.map((d) => {
    const ordered = [...(byDraft.get(d.id) ?? [])].sort(byTimeThenId);
    const latest = ordered.at(-1) ?? null;

    return {
      ...d,
      status: latest ? latest.decision : "draft",
      decisions: ordered,
      feedbackHistory: ordered.map((x) => x.feedback).filter((f) => f.trim() !== ""),
      lastActivityAt: latest ? latest.createdAt : d.createdAt,
    };
  });

  folded.sort((a, b) => {
    const diff = b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  return { drafts: folded, orphanedDecisions: [...orphanedDecisions].sort(byTimeThenId) };
}
