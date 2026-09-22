/**
 * Every environment variable this system expects, and what breaks without it.
 *
 * Three features have shipped tested, green, and silently inert because their
 * variable was unset in production: `SEAL_API_TOKEN`, `META_AD_ACCOUNT_ID`,
 * and `ANALYTICS_DATABASE_URL`. Each behaved correctly in isolation — checked
 * for its variable, found it absent, degraded politely. Nothing lied. But the
 * degradation went to **stderr at startup**, which nobody reads, and every
 * downstream surface carried on looking healthy. There was no way to ask the
 * system what it was missing (#35).
 *
 * Writing this manifest found the next one: `GOOGLE_SERVICE_ACCOUNT_JSON` and
 * `GSC_SITE_URL` are read by the worker and were in no `.env.example`. They
 * happen to be set on Railway, so Search Console syncs — but a fresh
 * environment built from the documentation would not have them, and the sync
 * would log `Skipped` every day for as long as anyone left it.
 *
 * ## Rules
 *
 * - `impact` says what stops working, not which variable is absent. "The query
 *   tool is unavailable" is actionable; "ANALYTICS_DATABASE_URL is missing"
 *   is a restatement of the problem.
 * - `required` means the surface cannot do its job at all. `degraded` means
 *   one feature is off and the rest still runs.
 * - Values are never read, stored, logged or returned by anything downstream.
 *   Presence only, by construction.
 */

export type Surface = "worker" | "web" | "mcp";
export type EnvSeverity = "required" | "degraded";

export interface EnvVariable {
  name: string;
  surfaces: Surface[];
  severity: EnvSeverity;
  /** What stops working. Written for someone who has to decide whether to care. */
  impact: string;
}

export const ENV_MANIFEST: EnvVariable[] = [
  {
    name: "DATABASE_URL",
    surfaces: ["worker", "web", "mcp"],
    severity: "required",
    impact: "Nothing can read or write the warehouse. Every surface is dead without it.",
  },
  {
    name: "ANALYTICS_DATABASE_URL",
    surfaces: ["mcp"],
    severity: "degraded",
    impact:
      "The `query` tool is unavailable, so ad-hoc SQL cannot be run from Claude Desktop. The other MCP tools still work.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    surfaces: ["worker", "web"],
    severity: "required",
    impact:
      "No generation of any kind: no blog drafts, no email copy, no guardrails, no weekly report prose.",
  },
  {
    name: "OPENAI_API_KEY",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Knowledge-base embeddings stop, so RAG retrieval degrades to whatever is already indexed.",
  },
  {
    name: "SHOPIFY_ACCESS_TOKEN",
    surfaces: ["worker"],
    severity: "required",
    impact: "Orders, products, customers and inventory stop syncing. Every revenue figure goes stale.",
  },
  {
    name: "SHOPIFY_STORE_DOMAIN",
    surfaces: ["worker"],
    severity: "required",
    impact: "Same as the access token: the Shopify client cannot be built without both.",
  },
  {
    name: "META_ACCESS_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Ad spend and creative performance stop syncing. Also breaks the organic Instagram sync.",
  },
  {
    name: "META_AD_ACCOUNT_ID",
    surfaces: ["worker"],
    severity: "degraded",
    impact:
      "The Meta sync runs and writes nothing — this is one of the three that shipped inert. `meta_insights` sits empty while the task logs a clean skip.",
  },
  {
    name: "INSTAGRAM_BUSINESS_ACCOUNT_ID",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Organic social performance stops syncing; `social_posts` goes stale.",
  },
  {
    name: "SEAL_API_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    impact:
      "Subscription records stop syncing. MRR, churn and LTV freeze at the last good sync — another of the three that shipped inert.",
  },
  {
    name: "SEAL_BASE_URL",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Seal falls back to its default host. Only matters if that host changes.",
  },
  {
    name: "GOOGLE_SERVICE_ACCOUNT_JSON",
    surfaces: ["worker"],
    severity: "degraded",
    impact:
      "Search Console stops syncing, so `gsc_daily` goes stale and organic search performance is unknown.",
  },
  {
    name: "GSC_SITE_URL",
    surfaces: ["worker"],
    severity: "degraded",
    impact:
      "Search Console cannot be queried even with valid credentials: the property has to be named, and its form must match the property exactly.",
  },
  {
    name: "COST_FORM_USER",
    surfaces: ["web"],
    severity: "degraded",
    impact:
      "The cost entry form at /costs refuses every request, so recurring overhead cannot be recorded. Nothing else on the dashboard is affected.",
  },
  {
    name: "COST_FORM_PASSWORD",
    surfaces: ["web"],
    severity: "degraded",
    impact:
      "Same as the user: the form fails closed without both, which is deliberate — an auth check that switches itself off when unset leaves a write surface that still looks protected.",
  },
  {
    name: "ATTENTIVE_API_KEY",
    surfaces: ["mcp"],
    severity: "degraded",
    impact: "The segment push tools are unavailable, so no audience can be sent to Attentive.",
  },
  {
    name: "ATTENTIVE_AGENT_USERNAME",
    surfaces: ["worker"],
    severity: "degraded",
    impact:
      "Attentive reporting stops entirely — campaign, journey, segment and message cost. The scraper logs a clean skip.",
  },
  {
    name: "ATTENTIVE_AGENT_PASSWORD",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Same as the username: the scraper needs both to log in.",
  },
  {
    name: "SLACK_BOT_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    impact:
      "The Slack bot cannot post. Tara loses her whole interface, and the Attentive scraper cannot ask anyone for a 2FA code.",
  },
  {
    name: "SLACK_APP_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Socket mode cannot connect, so the bot never receives a message even if it can send one.",
  },
  {
    name: "SLACK_REPORT_CHANNEL",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Proactive reports and alerts have nowhere to go; they are computed and dropped.",
  },
  {
    name: "DROPBOX_APP_KEY",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Knowledge-base document sync stops, so the brand bible stops picking up new documents.",
  },
  {
    name: "DROPBOX_APP_SECRET",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Same as the app key: Dropbox needs all three credentials.",
  },
  {
    name: "DROPBOX_REFRESH_TOKEN",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Same as the app key. Dropbox access tokens are short-lived, so this is the one that actually expires.",
  },
  {
    name: "DROPBOX_KB_ROOT",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Falls back to /RAD/Agency. Only matters if the folder moves.",
  },
  // Shotstack and the Dropbox footage/render roots were in `.env.example` and
  // are read by nothing: the video pipeline is deferred (#13). A variable
  // documented for code that does not exist is the same claim as a project
  // map naming a file nobody wrote, so they were removed rather than
  // described. The pipeline reintroduces them when it is built.
  {
    name: "ASSEMBLYAI_API_KEY",
    surfaces: ["worker"],
    severity: "degraded",
    impact: "Video transcription is unavailable. The video pipeline is not built yet (#13), so nothing calls it today.",
  },
  {
    name: "VOICE_API_KEY",
    surfaces: ["web"],
    severity: "degraded",
    impact:
      "The /api/generate route rejects every request, so the Figma plugin cannot generate email copy.",
  },
];

/** One variable's state on one surface. Never carries a value. */
export interface EnvCheckEntry {
  name: string;
  present: boolean;
  severity: EnvSeverity;
  impact: string;
}

export interface EnvCheckResult {
  surface: Surface;
  entries: EnvCheckEntry[];
  missingRequired: EnvCheckEntry[];
  missingDegraded: EnvCheckEntry[];
  /** True when nothing expected on this surface is absent. */
  complete: boolean;
}

/**
 * What this surface has and has not got.
 *
 * Takes the environment as an argument rather than reading `process.env`, so
 * it is testable without mutating global state — and so a surface can never
 * accidentally report another surface's environment.
 *
 * A variable set to the empty string counts as absent. An empty `SEAL_API_TOKEN`
 * authenticates exactly as badly as an unset one, and Railway writes an empty
 * string when a variable is created and never filled in.
 */
export function checkEnv(
  surface: Surface,
  env: Record<string, string | undefined>,
  manifest: EnvVariable[] = ENV_MANIFEST
): EnvCheckResult {
  const entries: EnvCheckEntry[] = manifest
    .filter((v) => v.surfaces.includes(surface))
    .map((v) => ({
      name: v.name,
      present: (env[v.name] ?? "").trim().length > 0,
      severity: v.severity,
      impact: v.impact,
    }));

  const missing = entries.filter((e) => !e.present);

  return {
    surface,
    entries,
    missingRequired: missing.filter((e) => e.severity === "required"),
    missingDegraded: missing.filter((e) => e.severity === "degraded"),
    complete: missing.length === 0,
  };
}

/**
 * The lines a surface prints at boot.
 *
 * The whole list, not just the failures. Ten PRESENT lines and one MISSING is
 * readable; a silent pass is what got us here — it is indistinguishable from
 * a check that never ran.
 */
export function formatEnvCheck(result: EnvCheckResult): string[] {
  const lines = result.entries.map(
    (e) => `  ${e.present ? "PRESENT" : "MISSING"}  ${e.name}${e.present ? "" : `  — ${e.impact}`}`
  );

  const header = `[env:${result.surface}] ${result.entries.length} expected, ${
    result.missingRequired.length
  } required missing, ${result.missingDegraded.length} optional missing`;

  return [header, ...lines];
}

/**
 * ─── Recording and reading a surface's check ──────────────────────────
 */

/** Exactly what goes in the database. Names and flags, by construction. */
export interface StoredEnvVariable {
  name: string;
  present: boolean;
}

/**
 * Strip a check down to what is safe to store.
 *
 * Typed as its own function rather than inlined at the insert, so the
 * "no values, ever" rule is one place that can be tested rather than a
 * convention every caller has to remember.
 */
export function toStoredVariables(result: EnvCheckResult): StoredEnvVariable[] {
  return result.entries.map((e) => ({ name: e.name, present: e.present }));
}

export type EnvReportStatus = "ok" | "degraded" | "broken" | "unknown";

export interface EnvReport {
  surface: Surface;
  status: EnvReportStatus;
  /** Null when no check has ever been recorded. */
  recordedAt: Date | null;
  ageHours: number | null;
  /** True when the record is too old to describe the process running now. */
  stale: boolean;
  missing: string[];
  detail: string;
}

/**
 * A recorded check is only evidence about the process that wrote it. The
 * worker redeploys often; a record from last month describes a process that no
 * longer exists.
 */
export const ENV_RECORD_STALE_AFTER_HOURS = 36;

/**
 * Turn a stored check into something a reader can act on.
 *
 * `unknown` when nothing was ever recorded. CLAUDE.md: no-run is UNKNOWN,
 * never PASS — and an empty table is the single most likely state on the day
 * this ships, so reading it as healthy would ship the exact bug this fixes.
 */
export function describeEnvRecord(
  surface: Surface,
  record: { recordedAt: Date; variables: StoredEnvVariable[]; missingRequired: number } | null,
  now: Date,
  manifest: EnvVariable[] = ENV_MANIFEST
): EnvReport {
  if (!record) {
    return {
      surface,
      status: "unknown",
      recordedAt: null,
      ageHours: null,
      stale: false,
      missing: [],
      detail:
        `No ${surface} has ever recorded an environment check, so what it is missing is unknown. ` +
        `This is not the same as nothing being missing.`,
    };
  }

  const ageHours = (now.getTime() - record.recordedAt.getTime()) / 3_600_000;
  const stale = ageHours > ENV_RECORD_STALE_AFTER_HOURS;
  const missingEntries = record.variables.filter((v) => !v.present);
  const missing = missingEntries.map((v) => v.name);

  const bySeverity = new Map(manifest.map((v) => [v.name, v.severity]));
  const missingRequired = missing.filter((n) => bySeverity.get(n) === "required");

  const status: EnvReportStatus = stale
    ? "unknown"
    : missingRequired.length > 0
      ? "broken"
      : missing.length > 0
        ? "degraded"
        : "ok";

  const detail = stale
    ? `The last ${surface} environment check was ${ageHours.toFixed(0)} hours ago, so it describes a process that has probably been replaced since. Treat it as unknown rather than current.`
    : missingRequired.length > 0
      ? `${surface} is missing ${missingRequired.join(", ")}, which it cannot run without.`
      : missing.length > 0
        ? `${surface} is running with ${missing.join(", ")} unset, so those features are off.`
        : `${surface} has every expected variable.`;

  return { surface, status, recordedAt: record.recordedAt, ageHours, stale, missing, detail };
}
