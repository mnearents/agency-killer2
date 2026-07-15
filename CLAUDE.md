# agency-killer2

Marketing automation platform for **Rad & Happy**, an e-commerce stationery brand
on Shopify. Replaces a real marketing agency with AI-driven analysis, creative
generation, and scheduling across Meta ads, email/SMS, organic social, SEO/GEO,
video editing, and inventory awareness.

Two users: **Matt** (technical, back-office/marketing ops) and **Tara** (CEO,
creative director, non-technical). Matt uses the dashboard + Slack. Tara uses
Slack + dashboard — she needs layman-friendly language, never terminal output.

## Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Language | TypeScript / Node.js | |
| Framework (web) | Next.js (App Router) | Read-only analytics dashboard |
| Framework (worker) | Plain Node + node-cron | Scheduled tasks + Slack bot |
| ORM | Drizzle | pgvector support, SQL-like composability |
| Database | PostgreSQL + pgvector | Railway managed Postgres |
| Test runner | Vitest | `vi.fn()` for mocks |
| AI | Anthropic SDK (Claude) | All generation, vision, guardrails |
| Embeddings | OpenAI `text-embedding-3-small` | RAG only — no other OpenAI usage |
| Slack | Bolt (socket mode) | Runs in worker process |
| Video transcription | AssemblyAI | Word-level timestamps, sentiment |
| Scene detection | PySceneDetect (local) | Free, no API cost |
| Video rendering | Shotstack | Cloud video composition |
| Image composition | Playwright + Sharp | HTML/CSS → PNG for email creative |
| Hosting | Railway | Two services: web + worker |

## Architecture

Two Railway services from one repo, different start commands:

- **Web** (`next start`): Dashboard pages. Pure read-only UI. No heavy processing.
- **Worker** (`tsx src/worker/index.ts`): Long-running process. Runs scheduled
  tasks via node-cron AND the Slack bot via Bolt socket mode. All "agency" logic
  executes here.

Both services share domain logic, DB layer, and integrations via imports from
`src/`.

### External services and API keys

Meta, Shopify, Dropbox, Attentive, Anthropic, OpenAI (embeddings only),
AssemblyAI, Shotstack, Slack. See `.env.example` for the full list. Never commit
`.env` or credentials.

Attentive and Statlas (CTC) have **no APIs** — data from these is imported
manually.

## Project structure

```
src/
├── domain/                 # Business logic — the core
│   ├── meta/               # Ad performance analysis, recommendations
│   ├── shopify/            # Orders, products, subscriptions, LTV
│   ├── email/              # Email/SMS campaigns, creative generation
│   ├── video/              # Analysis pipeline, edit decisions, rendering
│   ├── social/             # Organic IG/FB analytics, reel creation
│   ├── blog/               # SEO/GEO article generation
│   ├── knowledge/          # RAG retrieval, document ingestion, chunking
│   ├── voice/              # Brand voice prompt assembly, validation
│   └── inventory/          # Stock monitoring, alerts, bundling
├── integrations/           # External API clients — the seams
│   ├── anthropic.ts        # Claude API (generation + vision)
│   ├── meta-api.ts         # Meta Marketing API
│   ├── shopify-api.ts      # Shopify Admin GraphQL
│   ├── dropbox.ts          # Dropbox file sync
│   ├── assemblyai.ts       # Audio transcription
│   ├── shotstack.ts        # Video rendering
│   ├── openai.ts           # Embeddings only
│   ├── attentive.ts        # Email/SMS events
│   └── playwright.ts       # Image composition (Playwright + Sharp)
├── ai/                     # LLM orchestration layer
│   ├── prompts/            # Prompt templates (deterministic assembly)
│   ├── guardrails.ts       # Output validation, fail-closed checks
│   └── orchestrator.ts     # Route tasks to appropriate models/prompts
├── db/                     # Drizzle ORM
│   ├── schema.ts           # All table definitions
│   ├── client.ts           # Connection + query helpers
│   └── migrations/         # Drizzle Kit migrations
├── worker/                 # Worker entry point
│   ├── index.ts            # Main: starts scheduler + Slack bot
│   ├── scheduler.ts        # node-cron task registration
│   ├── tasks/              # One file per scheduled task
│   └── slack/              # Bolt handlers, commands, message routing
└── lib/                    # Shared utilities (dates, formatting, etc.)

app/                        # Next.js App Router (dashboard)
templates/email/            # HTML/CSS email templates (Playwright renders)
tests/                      # Mirrors src/ structure
tests/evals/                # LLM evals (tier 1 only)
```

## Integration seam pattern

Every external service exports an **interface + factory function**. Tests swap
mocks at this boundary. This is the single most important architectural pattern
in the codebase — it makes the deterministic core testable.

```typescript
// src/integrations/meta-api.ts
export interface MetaApiClient {
  getCampaigns(accountId: string): Promise<Campaign[]>;
  getInsights(params: InsightsParams): Promise<Insight[]>;
}
export function createMetaApiClient(config: MetaConfig): MetaApiClient { ... }
```

```typescript
// tests/mocks/meta-api.ts
export function createMockMetaApiClient(
  overrides?: Partial<MetaApiClient>
): MetaApiClient {
  return {
    getCampaigns: vi.fn().mockResolvedValue([]),
    getInsights: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
```

Apply this pattern to every integration: Anthropic, Meta, Shopify, Dropbox,
AssemblyAI, Shotstack, OpenAI, Attentive, Playwright, Slack.

## Knowledge base & RAG

- Documents stored in Postgres with pgvector embeddings (1536 dimensions).
- **Hybrid retrieval**: filter by category metadata first, rank by cosine
  similarity within the filtered set.
- **Anthropic prompt caching** for the "brand bible" (~40K tokens: brand
  philosophy, voice rules, style specs, active strategy). Cached as system prompt
  prefix — ~90% cheaper than uncached.
- **Dynamic RAG** for the rest: meeting notes, testimonials, product info.
- Embeddings via OpenAI `text-embedding-3-small`. Total cost: ~$0.02/month.
- Chunk by document type: meeting notes by agenda item (date prepended), brand
  docs by section heading, testimonials kept whole.
- No LangChain. ~200 lines of Drizzle + OpenAI SDK.

## Brand voice

Tara's writing voice is replicated via few-shot prompting — 37 writing samples,
brand rules, and banned words assembled into the system prompt. No fine-tuning.

- Voice module lives in `src/domain/voice/`.
- Samples stored in the knowledge base (Postgres, `voice` category). Small enough
  to include in full for every generation.
- Brand rules and banned words are part of the cached brand bible prefix.
- **Every marketing output routes through the voice module** — ad copy, email
  copy, blog posts, social captions, Slack-generated content.
- The Figma plugin voice service (`../ig-crawler`) stays running separately on
  Railway. Samples are mostly stable — no sync needed.

## Video analysis pipeline

```
Video file
  → PySceneDetect      → scene boundaries (free, local)
  → FFmpeg             → extract key frames (~60-90 per video, not every frame)
  → Claude Vision      → Haiku for bulk classification; Sonnet for flagged frames
  → AssemblyAI         → word-level transcription, sentiment, filler detection
  → Fuse signals       → per-segment quality score + edit decision list
```

Smart frame sampling: scene-start frames + mid-scene samples + pre-cut frames.
7-10x cheaper than 1fps. Blooper detection is multi-signal: visual (Claude) +
audio (AssemblyAI silence/filler/sentiment).

## Image composition (email creative)

Playwright renders HTML/CSS templates to pixel-perfect PNG. Sharp handles
post-processing (compression, resizing). Templates live in `templates/email/`.

- Custom brand fonts loaded via `@font-face` with bundled `.woff2` files.
- Full CSS typography: `letter-spacing`, `line-height`, `font-feature-settings`.
- Single Playwright browser instance reused across renders.
- Tara can preview templates in any browser — what she sees is what gets generated.

## Running the project

```bash
pnpm install                          # install dependencies
pnpm run db:migrate                   # run Drizzle migrations
pnpm run dev:web                      # Next.js dev server
pnpm run dev:worker                   # worker + Slack bot
pnpm run test                         # tier 0: fast deterministic tests
pnpm run test:all                     # tier 1: full suite + evals
```

## Testing & verification

**Tests are what stop the agents from doing weird stuff. A test that can't fail,
or that silently doesn't run, is worse than no test — it's false safety. Every
rule below exists to make a real failure impossible to miss.**

### Two layers, tested two different ways
This is an LLM-driven system, so split every feature in two:
1. **Deterministic core** — everything that is NOT a live model call: routing,
   orchestration, prompt assembly, tool dispatch, output parsing, retries, state,
   data transforms, and the guardrails themselves. Test with the model MOCKED.
   Fast, fully deterministic, the default gate.
2. **Model boundary** — the actual generations. Cover with EVALS (below), never
   in the fast tier.
Rule: if a bug reproduces with the model mocked, it belongs in layer 1, not an
eval. Push logic OUT of the model boundary into testable deterministic code.

### Determinism (non-negotiable for layer 1)
- Mock the model client. `temperature=0` is NOT determinism — return canned
  responses.
- No real network. Stub every external service (ad platform, CRM, email,
  analytics) behind a seam.
- No wall-clock / no `now()` / no unseeded randomness. Freeze time, inject seeds.
- Same test, twice, same result — always. Fix or delete a flaky test the day it
  flakes; a tolerated flake trains everyone to ignore red.

### Fast, small, tiered
- One behavior per test; name the behavior. Millisecond-fast.
- **Tier 0 (per-change gate):** the fast deterministic tests for the subsystem
  you touched. Run after EVERY change. "Changed the router → run router tests."
  Command: `vitest run tests/domain/<subsystem>`
- **Tier 1 (release / behavior gate):** full suite + evals. Run before merging a
  behavior change and as the pre-release gate. Slow; not per-edit.
  Command: `vitest run` then `vitest run tests/evals`
- Never use the slow suite as your inner loop; never gate a code typo behind a
  10-minute eval.

### TDD, red-first — always
- Red → green → refactor. Write the failing test first; watch it fail for the
  RIGHT reason; make it pass; clean up.
- **Found a bug? Reproduce it with a failing test BEFORE you fix it.** The test
  that goes red on the exact bug then green on the fix is the deliverable, not
  the fix alone. That's how a bug never comes back.

### Guardrails are deterministic code — test them hardest
- The "doesn't do weird stuff" safety net is deterministic logic: feed it a
  canned weird output, assert it catches it. No model needed.
- Guardrails FAIL CLOSED: an output you can't parse/validate is BLOCKED, never
  passed through. An empty/errored/unparseable check is a FAILURE, never a pass.
- Every guardrail gets adversarial fixtures built red-first: the fabricated
  statistic, the injected prompt, the leaked PII, the malformed JSON, the
  10x-too-long output, the off-brand tone, the empty output. If you can imagine
  the weird thing, a fixture asserts the guard stops it.

### Fail-loud gates (a green that isn't real is the enemy)
- **No-run is UNKNOWN, never PASS.** An all-skipped suite, or a category that
  matched zero tests, must report FAILURE. Zero executed assertions ≠ pass.
- **Never bypass a gate to make it green** (no skip/comment/xfail to ship). Fix
  the code or fix the gate.
- **Verify the test actually reached its assertion.** Confirm it goes red when
  the behavior is broken — a test that passes without exercising the target is a
  silent failure.
- **Success signals must not precede the check.** Don't emit "OK" before the last
  gate runs; trust the thing that verified, not a log line a failure could share.
- **Expected-negative tests assert the EXACT expected error only** — a different
  error must still fail the test.

### Evals (the model boundary)
- Golden fixtures + a rubric. Pin and version the judge model AND judge prompt;
  a changed judge/fixture is a new eval — re-baseline deliberately.
- Output is stochastic: run each case N times, assert a THRESHOLD (e.g. ≥9/10
  on-brand), never a single sample. N=1 is not evidence.
- A judge error or empty generation is a FAIL, never a pass.
- Evals gate behavior changes and releases, not every keystroke.
- Eval tests live in `tests/evals/`, separate from the fast tier.

### Don't water it down
- Never weaken an assertion to get green. High pass rate from weak assertions is
  not coverage.
- Test the real behavior an agent will exhibit, not a convenient proxy.
- Deterministic-core coverage approaches complete; the model boundary is covered
  by evals, not by pretending it's deterministic.

### Test file conventions
- `tests/` mirrors `src/` — `tests/domain/meta/analysis.test.ts` tests
  `src/domain/meta/analysis.ts`.
- No test files inside `src/`.
- Mock factories live in `tests/mocks/` — one per integration.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on this repo (`mnearents/agency-killer2`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
