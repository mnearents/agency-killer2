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

- **Web** (`next start`): Dashboard pages. Read-only except `/costs`, which
  records recurring overhead behind Basic auth (#34) — the one write surface,
  and the one place a credential exists. No heavy processing.
- **Worker** (`tsx src/worker/index.ts`): Long-running process. Runs scheduled
  tasks via node-cron AND the Slack bot via Bolt socket mode. All "agency" logic
  executes here.

Both services share domain logic, DB layer, and integrations via imports from
`src/`.

### External services and API keys

Meta, Shopify, Dropbox, Attentive, Anthropic, OpenAI (embeddings only),
AssemblyAI, Shotstack, Slack. See `.env.example` for the full list. Never commit
`.env` or credentials.

**Attentive has a REST API, and it has no reporting in it.** Those are two
separate facts and conflating them is what produced the previous version of
this paragraph, which said Attentive had no API at all.

- `src/integrations/attentive-write.ts` uses `api.attentivemobile.com` with
  `ATTENTIVE_API_KEY` to push segment membership and read subscriber
  eligibility. That is a real, working API.
- There is no campaign, journey, message or report endpoint on it. Verified by
  probing: `/v1/me` answers 200, `/v1/campaigns`, `/v1/journeys`, `/v1/reports`
  and `/v1/messages` all 404. Reporting is not in the public API at any tier.
- So reporting is **scraped**, not imported by hand:
  `src/integrations/attentive-agent.ts` drives Playwright through the Attentive
  UI, handles SMS 2FA by asking Slack for the code, downloads CSV exports and
  persists its cookies in `agent_sessions` for the next run. Credentials are
  `ATTENTIVE_AGENT_USERNAME` / `ATTENTIVE_AGENT_PASSWORD`.
- **Segment membership cannot be read back from Attentive at any tier** (#23).
  We know our own segment sizes because we define them in Postgres and push
  them (#32); Attentive will not tell us what is in a list.

Six reports are scraped. The slugs are listed at `/analytics/reports` —
`/analytics/reports/library` renders nothing on its own, which is why they went
unfound for so long:

| slug | table |
|---|---|
| `campaign-performance-aggregate-group` | `attentive_campaigns` (one row per day per channel) |
| `attributed-revenue` | `attentive_revenue` |
| `campaign-aggregate-performance-aggregate-group` | `attentive_campaign_messages` |
| `campaign-performance-by-segment` | `attentive_campaign_segments` |
| `journeys-message-level-performance-v2` | `attentive_journey_messages` |
| `daily-message-cost` | `attentive_message_costs` |

Two traps in that data. **Campaign rows and segment rows are the same revenue
counted twice** — segment rows break the same sends out by audience, so never
sum the two tables. And **every export opens with an aggregate row**, labelled
`Total` in five reports and `Overall Performance` in the sixth; kept, it
becomes a campaign with six figures of deliveries and no date.

**Attentive shows in-app marketing popups that cover the Export button.** They
render into `#engagement-wrapper` and swallow the click, and Playwright reports
the button "visible, enabled and stable" while retrying for thirty seconds — so
the failure is a click timeout that names nothing. `exportReport` clears them
first. If a new page stops exporting, look for an overlay before anything else.

The session did not persist (#95), and the stored one says why: **4 cookies,
none httpOnly, not one of them a session cookie** — `_ga`, `_dd_s`, `AMP_*`,
all analytics, plus 16 localStorage keys of Amplitude and Pendo. Nothing that
could authenticate anything. So every run logged in afresh and asked Slack for
a 2FA code nobody answered.

Capture is now `context.storageState()` — Playwright's own mechanism, which
returns cookies for every domain the context touched, httpOnly included, and
is consumed directly by `newContext`. **`sessionStorage` is captured
separately** because storageState omits it, and it is the one place an SPA can
hold a token that neither cookies nor localStorage would show; nothing had
looked there. It is restored with `addInitScript`, before the app boots, rather
than by navigating and calling `setItem` afterwards.

`diagnoseSession` decides whether a capture could authenticate at all, and the
run says so **before** reusing it rather than after a 2FA prompt ten minutes
later. If a fresh login still yields nothing usable, that is reported as an
error on the run instead of being discovered next time.

### 3PL cost data — three files, none of them sufficient alone

Fulfilment is Evobox (Lehi, UT), running ShipHero. Cost of delivery for the
physical line is assembled from three exports, and the reconciliation between
them is a feature rather than a check someone remembered to do.

| File | Grain | Table | Authority on |
|---|---|---|---|
| charge ledger CSV | one row per charge | `threepl_charges` | what each charge was *for* |
| shipment CSV | one row per label | `threepl_shipments` | postage per order |
| invoice PDF | five category totals | — | what was actually *charged* |

**The charge ledger is not the whole bill.** Against bill 720698 it sums to
$681.60 and the invoice to $811.28. The gap is entirely in `Order charges` and
is postage, which the ledger does not itemise — confirmed exactly: the shipment
export's label costs for that window sum to $129.74, matching to the cent. So
`reconcileInvoice` runs on every import, because a category that stops being
itemised looks identical to one that stopped being charged.

**69% of shipments have no postage cost anywhere we can see.** Every DHL BPM
Ground label — 1,726 of 2,508 over thirteen months — exports as `Label Cost =
0.00`. BPM is not free; those bill to a separate DHL eCommerce account. They
are stored with `label_cost_cents = NULL` and `postage_basis = 'unbilled'`,
never as zero, and `postageCoverage` returns the share that is real (31.0%) as
a value so no caller can quote the cost without it.

**Fulfilment moved to USPS Media Mail on 2026-09-22.** Media Mail is flat —
no zones — and applies no dimensional weight, which retires both inputs that
were outstanding from DHL. Repricing the 1,726 BPM shipments: $12,005 against a
DHL band of $12,708-$18,441, with the saving concentrated on wall calendars
($15.37 to $6.65 a shipment). `USPS_MEDIA_MAIL_2026` holds the card, and
`MEDIA_MAIL_ELIGIBILITY_NOTE` holds the catch: Media Mail covers books and
similar reading matter, blank planners and calendars are the commonly disputed
cases, and USPS may inspect and assess postage due. Historical parcels still
rate on DHL, which is why both cards exist.

`DHL_BPM_GROUND_2026` in `domain/economics/postage-rates.ts` is the client rate
card for labels shipped before that date. **BPM is not the cheap service it sounds like**: a 2.5lb
parcel is $7.08 to zone 1 and $10.74 to zone 8 before fuel, and an estimate of
"$2.50-4.00 for book rate" was wrong by a factor of three. The card reproduces
the one known DHL invoice ($103.97) at zone 7.

Rating is per shipment, from the weight and destination postcode already on
each row — never an average, because BPM parcels run 0.06 to 8.15lb across
every zone. **The zone chart is the one input still missing**, so postage is a
band (`rateBand`) rather than a figure: $12,708-$18,441 a year against $6,190
of BPM shipping collected. Carriers charge the first weight break at or above
the parcel weight, so rating rounds up, never to nearest.

Other traps:

- The charge CSV has **newlines inside quoted fields** — 204 physical lines for
  202 records. Splitting on newlines before honouring quotes shreds records
  into fragments that still parse, and it was understating the bill by $8.19.
- **Two columns can carry the order reference.** In the observed export it is
  `Order # (shipment)`; `ORDER NUMBER` is entirely empty. The parser picks by
  measuring both against the live `RH######` shape rather than by name.
- **Bills are biweekly**, not monthly, so a year is ~28 files of each kind.
- Storage is **57% of a typical bill** and attributable per SKU, so slow-moving
  physical inventory carries real cost in a month it sells nothing.
- Recurring software the 3PL bills (`API CONNECTION`, $125/period) goes to
  `recurring_costs`, **never into COD** — a fixed fee folded into a per-order
  cost makes COD% move with volume, and break-even aMER is 1/(1-COD%).

Import with `pnpm threepl:import <file|directory>`; it detects which kind of
file it was given and writes nothing without `--write`.

Statlas (CTC) has no API. Its data is imported manually.

### Subscription data — read this before counting subscribers

**`shopify_customers.customer_tags` carries subscription lifecycle state and is
the authoritative source for lapsed subscribers.** Seal only holds the current
app's records and undercounts by roughly 10,000 due to migration loss.

The business has run three subscription apps and migrated twice. Shopify
subscription apps do not migrate cancelled subscribers, so each migration
dropped its churned population and Seal holds only the survivors of the most
recent one — 593 cancellations against a real **15,364**. Never define churn
from `seal_subscriptions` or from `is_subscriber`.

- Lapsed is `inactive_subscriber` **OR** `inactive-subscriber`, minus
  `active-subscriber`. **Both spellings are live** (9,065 and 7,847); matching
  one halves the segment and still returns a plausible five-figure number.
  There is no `cancelled-subscriber` tag.
- **`customer_tags` and `shopify_orders.tags` are different things that share a
  name.** Order tags are the *product's* tags copied onto the order —
  `homeschool` sits on 42,094 of 54,225 orders — and say nothing about the
  buyer. Never segment on them.
- Real subscription dates did not survive the migrations.
  `first_subscription_order_at` / `last_subscription_order_at` are proxies from
  orders of a `product_type = 'Subscription'` SKU, and are **NULL for 85.7% of
  the lapsed**, who churned before order history begins (2025-07-22). Recovering
  their dates needs an Appstle export, not more query work.
- Seal covers Really Awesome Doodles only; Color Happy ran in Appstle. A
  subscriber count from Seal is a RAD count.

### MCP server (Claude Desktop)

A third entry point (`pnpm mcp`, stdio) that lets Claude Desktop read the
system directly. Local only — no internet-facing endpoint, no auth layer.

Division of labour with the scheduler: **crons own ingestion and deterministic
alerting** (no judgment, must run unattended, no token cost); **Claude owns
interpretation, creative, and decisions**. Crons are reliable at running and
bad at noticing they're wrong, which is the gap MCP fills.

Rules for tools in `src/mcp/`:

- **Return structured data, never Slack-formatted prose.** Do not wrap the
  handlers in `src/worker/index.ts` — those return language written for Tara.
  A model handed a formatted summary cannot check the numbers behind it.
- **Money is dollars.** No cents-denominated field crosses this boundary;
  `spendCents: 250000` misread as "$250,000" is a plausible, expensive mistake.
- **Capped lists report both what was returned and what matched**, so a sample
  is never mistaken for the whole set.
- **Unknown arguments are errors**, not ignored — a silently dropped filter
  leaves the caller believing it narrowed a result set it read whole.
- **Errors are returned, not thrown**, and never alongside partial data.
- **Most tools are read-only; nine are not.** The writers are `calendar_add`,
  `calendar_update`, `calendar_remove`, `draft_save`, `draft_record_decision`,
  `experiment_start`, `experiment_record_result`, `pilot_notes_add` and
  `segment_push`. That list is asserted in `tests/mcp/tools.test.ts`, so a new
  write tool cannot appear without someone declaring it there.
- **A write tool records that Claude was the author.** Calendar entries set
  `aiSuggested` and the caller cannot override it: Tara reads the calendar, and
  an AI-planned week must not be indistinguishable from one she planned.
- **What has already happened is not editable.** A calendar entry that is
  `sent` or `posted` accepts only a note; correcting one marked so by mistake
  needs `correction:true` and a reason, which is recorded. Without that path,
  protecting history would have made a data-entry error permanent — and with
  it, the way back to editing content is two deliberate steps, not one flag.
- `segment_push` is the only tool that reaches an external service.

Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rad-and-happy": {
      "command": "/usr/local/bin/pnpm",
      "args": ["--silent", "--dir", "/Users/matthewnearents/agency-killer2", "mcp"],
      "env": {
        "DATABASE_URL": "<Railway DATABASE_PUBLIC_URL>",
        "ANALYTICS_DATABASE_URL": "<claude_readonly URL>",
        "ATTENTIVE_API_KEY": "<key>",
        "OPENAI_API_KEY": "<key>"
      }
    }
  }
}
```

Only `DATABASE_URL` is required. Each of the others degrades one thing and says
so: without `ANALYTICS_DATABASE_URL` the `query` tool reports itself
unavailable, without `ATTENTIVE_API_KEY` the segment push tools do, and without
`OPENAI_API_KEY` `kb_search` falls back to literal substring matching and
labels itself `text` rather than passing a worse search off as the semantic one.

`--silent` is load-bearing: without it pnpm prints its `> tsx src/mcp/index.ts`
banner to **stdout**, which is the JSON-RPC channel, and the handshake fails.
For the same reason `src/mcp/index.ts` logs to stderr only. Use the public
Railway URL — the internal one does not resolve off-platform.

That entry is the *development* one: it runs from the working tree, so an edit
to `src/mcp/` takes effect on the next Claude Desktop restart.

#### Installing on a machine that does not have this repo

`pnpm mcp:bundle` writes `dist/mcp/` — two self-contained ESM files, an env
template and a README. Copy that folder to the other machine and run
`node install.mjs` inside it. Node 22 is the only prerequisite: no clone, no
pnpm install, no node_modules, no toolchain.

This works because the MCP import graph is pure TypeScript over three pure-JS
packages (`@modelcontextprotocol/sdk`, `drizzle-orm`, `postgres`). Nothing in
it compiles per-platform, so one bundle built on any machine runs on all three
desktop platforms. It is also why the bundle must not grow a native dependency
without someone reconsidering this.

Three things the build and the installer enforce, each for a failure that is
otherwise silent:

- **No module that resolves paths at runtime may enter the bundle.** Bundled,
  `import.meta.url` points at the bundle and the `process.cwd()` fallback
  points wherever Claude Desktop started the process — neither is the repo.
  `src/domain/voice/loader.ts` and `src/db/schema-gate.ts` both do this; both
  are currently outside the MCP graph, and `DISK_READERS` in
  `scripts/build-mcp.ts` fails the build if that changes. Such a module works
  here and throws there.
- **The config records an absolute path to the node binary**, taken from
  `process.execPath` of the node that ran the installer. Claude Desktop is a
  GUI app and does not inherit the shell's PATH, so a bare `node` resolves
  against a minimal system PATH — which is not where a version manager keeps
  node. This is the same reason the development entry above names
  `/usr/local/bin/pnpm` rather than `pnpm`.
- **The installer proves the server runs before reporting success.** It speaks
  JSON-RPC to the command it just wrote and counts the tools listed. Writing a
  config is not evidence: a config pointing at a node that does not exist is
  written perfectly and produces a client that lists nothing and says nothing.

The installer merges into `mcpServers` rather than replacing it, so other
servers on that machine survive. It reports unrecognised keys in the env file
instead of dropping them — a misspelled `ATTENTIVE_APIKEY` is otherwise
indistinguishable from a deliberate omission.

`DATABASE_URL` is the only required credential. `ANALYTICS_DATABASE_URL` and
`ATTENTIVE_API_KEY` are optional and their tools report themselves unavailable
when absent, so a machine that should only read can be given the first alone —
note that leaving out `ATTENTIVE_API_KEY` is what makes an install read-only,
since the segment push tools are the only writes in the surface.

Updating a machine is replacing the two `.mjs` files; the config keeps pointing
at the same paths. Moving the folder breaks it, because those paths are
absolute — re-run `node install.mjs` after a move.

## Project structure

```
src/
├── domain/                 # Business logic — the core
│   ├── meta/               # Ad performance analysis, recommendations
│   ├── shopify/            # Orders, products, customers, segments, product copy/SEO
│   ├── subscriptions/      # Seal facts, LTV, tier movement
│   ├── economics/          # COD, contribution margin, target CPA, aMER, 3PL costs
│   ├── email/              # Email/SMS campaigns, creative generation
│   ├── attentive/          # Scraped report import and queries
│   ├── social/             # Organic IG/FB analytics, reel creation
│   ├── blog/               # SEO/GEO article generation
│   ├── seo/                # Search Console and web sessions sync + queries
│   ├── footage/            # Dropbox video: transcribe, tag, index
│   ├── knowledge/          # RAG retrieval, document ingestion, chunking, queries
│   ├── voice/              # Brand voice prompt assembly, validation
│   ├── inventory/          # Stock monitoring, alerts, bundling
│   ├── segments/           # Segment definitions and the Attentive push
│   ├── experiments/        # Declared experiments and their results
│   ├── drafts/             # Generated drafts and decisions on them
│   ├── calendar/           # Marketing calendar entries
│   ├── alerts/             # Deterministic alert rules
│   ├── report/             # Weekly report assembly
│   ├── qa/                 # Output quality checks
│   └── pilot/              # Pilot notes — the engine's own log
├── integrations/           # External API clients — the seams
│   ├── anthropic.ts        # Claude API (generation + vision)
│   ├── meta-api.ts         # Meta Marketing API
│   ├── shopify-api.ts      # Shopify Admin GraphQL
│   ├── dropbox.ts          # Dropbox file sync
│   ├── assemblyai.ts       # Audio transcription
│   ├── openai.ts           # Embeddings only
│   ├── seal-api.ts         # Seal subscriptions
│   ├── search-console.ts   # Google Search Console
│   ├── shopify-analytics.ts # ShopifyQL (sessions)
│   ├── instagram-api.ts    # Organic IG/FB
│   ├── attentive-write.ts  # Attentive REST API (segment push, eligibility)
│   └── attentive-agent.ts  # Playwright scrape of Attentive reports (no API)
├── ai/                     # LLM orchestration layer
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
├── mcp/                    # MCP server (Claude Desktop pilots the app)
│   ├── index.ts            # stdio entry point
│   ├── server.ts           # Transport-agnostic server construction
│   ├── tools.ts            # Tool surface over the domain query layer
│   ├── args.ts             # Fail-closed argument validation
│   ├── install.ts          # Installer logic — pure, for the portable bundle
│   └── install-cli.ts      # Installer entry point (bundled as install.mjs)
└── lib/                    # Shared utilities (dates, formatting, etc.)

scripts/
├── build-mcp.ts            # Bundles the MCP server for another machine
└── import-threepl.ts       # Imports 3PL charges, shipments and invoices

app/                        # Next.js App Router (dashboard)
templates/email/            # HTML/CSS email templates (Playwright renders)
tests/                      # Mirrors src/ structure
tests/evals/                # LLM evals (tier 1 only)
```

**Shotstack** is not built. Half of #13 now is: `/RAD/Footage` is synced,
transcribed by AssemblyAI and tagged by Claude from the transcript, and each
clip's words land in the knowledge base under category `footage` so `kb_search`
finds it. What is NOT built is anything that looks at the picture — scene
detection, frame extraction, vision tagging, edit decision lists, rendering.
So **silent b-roll is listed, marked `no-audio` and untagged**: there are no
words to tag it from, and that is an ordinary outcome rather than a failure. **Playwright** has no wrapper
module; it is used directly by `integrations/attentive-agent.ts` and
`domain/email/renderer.ts`.

Every other path above is asserted by `tests/docs/claude-md-structure.test.ts`,
which fails if this tree names a file that does not exist. It was added after
this map spent the project pointing at `integrations/attentive.ts`, which was
never written.

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

Tara's writing voice is replicated via few-shot prompting — **84 writing
samples**, brand rules, and banned words assembled into the system prompt. No
fine-tuning.

The count said 37 for a long time and was never right: 34 samples plus 3 rules,
added together. The 34 became 84 when `IGMULTI` — forty unrelated captions
concatenated into one 16,724-character record, 57% of the corpus by volume —
was split into its constituent captions (#53).

- Voice module lives in `src/domain/voice/`.
- Samples live in the dedicated `voice_samples` table, **not** the knowledge
  base's `voice` category. Small enough to include in full for every generation.
  `voice-profile-seed.json` is the authoring surface and is reconciled into the
  table on every boot.
- Brand rules and banned words are part of the cached brand bible prefix.
- **Every marketing output routes through the voice module** — ad copy, email
  copy, blog posts, social captions, Slack-generated content.
- The Figma plugin voice service (`../ig-crawler`) stays running separately on
  Railway. Samples are mostly stable — no sync needed. **The plugin is an email
  tool** despite the name and the all-Instagram corpus, so never infer a channel
  from either.

### Channel scoping

Rules are prohibitions, and scope is expressed as `exceptIn` — the channels a
rule does *not* apply to — never `appliesTo`. A channel nobody remembered to add
then inherits every prohibition rather than none, which is wrong in the direction
someone notices. `unspecified` is not a channel: it is the audience excused from
nothing, and it is what a caller passes when it genuinely does not know.

Three things have to name the same audience, and two of them used to disagree:

- `assembleVoicePrompt(profile, audience)` — what the model is *told*.
- `voiceCheck(text, audience, profile)` — what the model is *graded against*.
- `selectSamples(samples, audience)` — which few-shot examples it sees.

Request builders derive `audience` from `voice.audience` rather than taking it
separately, so the agreement is structural rather than a convention two call
sites have to keep. `OrchestratorRequest.audience` is required, which is what
forces every generator to state it.

Every sample is currently tagged `channel:instagram`, so asking for any other
channel falls back to the whole corpus. That is deliberate — email copy written
from the Instagram corpus works in practice, and scoping to an empty set would be
worse than the problem — but the fallback is always named in the return value,
never silent.

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
pnpm run mcp:bundle                   # build dist/mcp/ for another machine
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

### Assert the call site, not just the behavior

**A component that is never invoked reports identically to one that runs and
finds nothing.** This is the most common way something ships broken here. It is
not a bug in the component — the component is usually correct and fully tested.
The wiring is what is missing, and nothing tests the wiring.

The signals it produces are all healthy ones:

- `0 evaluated, 0 failed` — nothing errored, because nothing ran
- `Skipped — X not set` on a daily cron, logged calmly for months
- an empty result set, which reads as "no matches" and not as "no query"
- a stated property in a docstring that no code implements

Every one of those is what a working system also prints on a quiet day. There is
no threshold, alert or non-zero exit separating them.

So, when you ship anything invocable:

- **Test that it is called, from where it is called.** A unit test over a
  function wired to nothing passes forever. The deliverable is the test that
  goes red when the call site is deleted.
- **Zero is UNKNOWN until something proves it means zero.** A count of nothing
  over a table that should hold rows is an unrun check, not a clean one. Make
  the empty case distinguishable in the return value, not just in a log line.
- **A claim in a comment or docstring is a claim about code that must exist.**
  If a header says a guard is in place, a test asserts the guard, not the
  header. Write the header after the test passes.
- **Grep for the call site before calling it done.** Definition + tests +
  no caller is the whole failure. It takes one search.

### Every fallback must be distinguishable from the success it replaces

**If a degraded read and a healthy read produce the same log line and the same
numbers, the degraded state is undetectable by construction.** No amount of
attention finds it, because there is nothing to notice. This is the generalised
form of the section above: the never-invoked component is one case, the silently
degraded one is the other, and both are invisible for the same reason.

So:

- **Name the source in the output, not just the count.** `Loaded 34 samples` is
  not a status. `Loaded 34 samples from the database` and `Loaded 34 samples from
  the seed file (database unreachable)` are.
- **The source has to survive the return.** The line an operator reads is printed
  by the caller. A loader that logs its own fallback and then hands back a bare
  value has told the wrong person.
- **Never overload one return value with two conditions that need opposite
  responses.** `null` meaning both "empty" and "the read threw" is what made an
  unreachable database look like an empty one — and empty gets seeded, while
  unreachable must not be. Return a discriminated union and let the type force
  the caller to choose.
- **Route the degraded path through a different channel.** `console.error`, not
  `console.log`. A fallback that is styled as routine reads as routine.

And, when verifying that something ran:

**Verify a signal only that thing could have produced — not a state something
else could have created.** After a corpus sync, `34 rows, 34 keyed, 0 unkeyed`
looked like proof the sync worked. It was entirely the backfill in the migration
that shipped alongside it. The sync's success and its total absence produce the
same numbers, so the numbers are not evidence. That is worse than a silent
failure: it is a silent failure with corroborating evidence pointing the wrong
way. Find the signal with a single possible author — a log line only that code
path emits, a row only it writes, a timestamp only it moves — and check that.

This rule would have caught #54, the Meta sync's daily `Skipped`, the expired
Seal token, and `seedSegments` never being called.

### Reconciling two figures that disagree
- **When two counts disagree, ask what the other side EXCLUDED before reaching
  for a basis mismatch.** "Different data source" and "different denominator"
  are unfalsifiable — they explain any gap, so they end the investigation with
  everyone satisfied and nobody right. The cause is almost always a predicate
  one side applied and the other did not.
- Do not grid-search filter combinations hunting for a target number. That
  looks for a coincidence that reproduces the figure, not the reason for it,
  and a coincidence will eventually turn up.
- If you cannot reproduce a number, **say so plainly and name your predicates.**
  Whoever quoted it can usually supply the missing one in a sentence.
- Name the classifier alongside any figure that depends on one. "Physical AOV"
  is two different numbers depending on whether physical means
  `shopify_inventory.tracked = 1` or a known `product_type`, and the gap is not
  noise — it is every product whose type was never set.

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
