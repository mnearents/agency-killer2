/**
 * The list of environment variables each entry point expects, and what stops
 * working when one is absent.
 *
 * Three features have now shipped tested and green with their variable unset in
 * production: SEAL_API_TOKEN on the worker, META_AD_ACCOUNT_ID on the Meta sync,
 * and ANALYTICS_DATABASE_URL on the MCP. In all three cases the code did the
 * right thing locally — it degraded, logged a line, and carried on — and nothing
 * downstream ever said the feature was off. The absence was the whole bug and it
 * was invisible.
 *
 * This module is the inventory that makes the absence visible. It is data, not
 * behaviour: `env-check.ts` evaluates it and the worker records the result so
 * `data_freshness` can report it.
 *
 * Every entry is a variable some code path actually reads. `.env.example` also
 * documents SHOTSTACK_API_KEY, SHOTSTACK_ENV, ATTENTIVE_API_KEY,
 * DROPBOX_FOOTAGE_ROOT, DROPBOX_RENDERS_ROOT and BLOG_AUTOMATION_ENABLED, which
 * nothing reads yet; they are deliberately absent here, because a check that
 * warns about a variable no code consumes teaches people to ignore the check.
 */

/** The three processes started from this repo. */
export const SURFACES = ["worker", "web", "mcp"] as const;

export type Surface = (typeof SURFACES)[number];

/**
 * How badly the absence hurts.
 *
 * - `required` — the process cannot do its job at all. Absence is a hard failure.
 * - `degraded` — the process runs, but a named feature is off. **This is the
 *   class all three production incidents fall into**, and the one worth shouting
 *   about, because it is the only class that looks healthy from the outside.
 * - `optional` — there is a working default. Absence is normal and must never be
 *   counted as a problem: a warning that is always on is a warning nobody reads,
 *   which is precisely how the three real ones stayed invisible.
 */
export type Severity = "required" | "degraded" | "optional";

export interface EnvRequirement {
  name: string;
  surfaces: readonly Surface[];
  severity: Severity;
  /**
   * What stops working, in the words of someone who would care.
   *
   * Deliberately never restates the variable name — "ANALYTICS_DATABASE_URL is
   * missing" tells a reader nothing they can act on, while "the query tool
   * cannot run SQL" is the sentence that makes someone go and fix it. A test
   * enforces that the name does not appear in here.
   */
  breaks: string;
}

const ALL = SURFACES;

export const ENV_MANIFEST: readonly EnvRequirement[] = [
  {
    name: "DATABASE_URL",
    surfaces: ALL,
    severity: "required",
    breaks: "nothing can start — every page, tool and scheduled task reads this database",
  },
  {
    name: "ANALYTICS_DATABASE_URL",
    surfaces: ["mcp"],
    severity: "degraded",
    breaks:
      "the query tool refuses every query, so ad-hoc analysis is unavailable; it will not fall back to the owner credentials because the PII exclusion depends on the read-only role",
  },

  // ─── AI ──────────────────────────────────────────────────────────────
  {
    name: "ANTHROPIC_API_KEY",
    surfaces: ["worker", "web"],
    severity: "degraded",
    breaks:
      "all generation stops: blog drafts, ad analysis, email copy and every Slack answer that needs a model",
  },
  {
    name: "OPENAI_API_KEY",
    surfaces: ["worker"],
    severity: "degraded",
    breaks:
      "new knowledge-base documents are never embedded, so RAG keeps retrieving only what was already indexed",
  },

  // ─── Meta ────────────────────────────────────────────────────────────
  {
    name: "META_ACCESS_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "the ad sync never runs and Meta performance data stops updating",
  },
  {
    name: "META_AD_ACCOUNT_ID",
    surfaces: ["worker"],
    severity: "degraded",
    breaks:
      "the ad sync returns early on every run and writes no insights — the failure that left meta_insights empty",
  },
  {
    name: "INSTAGRAM_BUSINESS_ACCOUNT_ID",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "organic Instagram reach and engagement are never collected",
  },

  // ─── Shopify ─────────────────────────────────────────────────────────
  {
    name: "SHOPIFY_ACCESS_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "order, customer and inventory syncs are skipped and storefront data goes stale",
  },
  {
    name: "SHOPIFY_STORE_DOMAIN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "the storefront client is never built, so order, customer and inventory syncs are skipped",
  },

  // ─── Subscriptions ───────────────────────────────────────────────────
  {
    name: "SEAL_API_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks:
      "the subscription sync is skipped, so active subscriber counts and recurring revenue go stale",
  },
  {
    name: "SEAL_BASE_URL",
    surfaces: ["worker"],
    severity: "optional",
    breaks: "nothing — the client falls back to the production Seal merchant endpoint",
  },

  // ─── Dropbox ─────────────────────────────────────────────────────────
  {
    name: "DROPBOX_APP_KEY",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "file sync is disabled: knowledge-base documents and video footage are never picked up",
  },
  {
    name: "DROPBOX_APP_SECRET",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "file sync is disabled: knowledge-base documents and video footage are never picked up",
  },
  {
    name: "DROPBOX_REFRESH_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "file sync is disabled: knowledge-base documents and video footage are never picked up",
  },
  {
    name: "DROPBOX_KB_ROOT",
    surfaces: ["worker"],
    severity: "optional",
    breaks: "nothing — the knowledge-base sync falls back to /RAD/Agency",
  },

  // ─── Video ───────────────────────────────────────────────────────────
  {
    name: "ASSEMBLYAI_API_KEY",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "video transcription is unavailable, so the analysis pipeline cannot score segments",
  },

  // ─── Slack ───────────────────────────────────────────────────────────
  {
    name: "SLACK_BOT_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "the bot never starts — Matt and Tara lose every command and every alert",
  },
  {
    name: "SLACK_APP_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "the socket connection never opens, so the bot does not start",
  },
  {
    name: "SLACK_REPORT_CHANNEL",
    surfaces: ["worker"],
    severity: "degraded",
    breaks: "proactive reports and alerts are computed and then dropped, having nowhere to post",
  },

  // ─── Web ─────────────────────────────────────────────────────────────
  {
    name: "VOICE_API_KEY",
    surfaces: ["web"],
    severity: "degraded",
    breaks: "the Figma plugin's generate endpoint rejects every request as unauthorised",
  },
];

/** The variables one surface actually reads. */
export function requirementsFor(surface: Surface): readonly EnvRequirement[] {
  return ENV_MANIFEST.filter((r) => r.surfaces.includes(surface));
}
