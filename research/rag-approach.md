# RAG Approach for Marketing Knowledge Base

Research into retrieval-augmented generation strategies for the Rad & Happy marketing knowledge base. The system needs to serve relevant context from ~500-1000 documents (meeting notes, brand guidelines, product info, ad strategy, testimonials, etc.) to an LLM that generates marketing decisions and content.

> **Note on sources:** WebSearch and WebFetch were unavailable during this research. Findings are based on well-established knowledge of these tools and ecosystems as of early-to-mid 2025. Verify pricing and Railway-specific details before implementation.

---

## 1. pgvector -- Vector Search in Postgres

### What it is

pgvector is a Postgres extension that adds a `vector` column type and similarity search operators (cosine distance, L2/Euclidean, inner product, and as of v0.7+ L1/Manhattan). It lets you store embeddings alongside your relational data and query them with standard SQL.

### Railway support

Railway's managed Postgres supports installing extensions. pgvector is available -- you enable it with `CREATE EXTENSION vector;`. Railway runs Postgres 15+ which is compatible with pgvector 0.5+. No additional infrastructure, no separate service, no extra billing beyond your existing Postgres instance.

To verify on your Railway instance:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT * FROM pg_extension WHERE extname = 'vector';
```

### Performance at this scale

At <1000 documents, pgvector is absurdly fast even without indexing. The HNSW index (added in pgvector 0.5.0) matters at 100K+ rows. At your scale, a sequential scan over 1000 vectors completes in single-digit milliseconds. You could do an unindexed brute-force scan and never notice.

For reference: pgvector benchmarks show ~1ms query times for 10K rows with HNSW index, and brute-force scans at 1K rows are comparable. You will not hit a performance ceiling with this dataset size.

### Hybrid search (metadata + vector)

This is where pgvector shines for this use case. Because embeddings live in regular Postgres rows, you can combine vector similarity with standard SQL filtering:

```sql
SELECT id, title, content,
       1 - (embedding <=> $1) AS similarity
FROM documents
WHERE category = 'brand-guidelines'
  AND created_at > '2025-01-01'
ORDER BY embedding <=> $1
LIMIT 5;
```

This "filter then rank" pattern is exactly what you want for queries like "what brand guidelines apply to holiday emails?" -- filter to brand docs, rank by semantic similarity to the query.

### TypeScript / Drizzle integration

**Drizzle ORM** has first-class pgvector support via the `drizzle-orm/pg-core` package:

```typescript
import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core'; // built-in as of Drizzle 0.29+

export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  category: text('category').notNull(),
  source: text('source'),  // e.g., 'dropbox', 'manual'
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});
```

For similarity search, Drizzle supports the distance operators. You can use `sql` template literals for cosine distance:

```typescript
import { sql } from 'drizzle-orm';
import { cosineDistance, gt } from 'drizzle-orm/sql'; // or use raw sql

const results = await db
  .select({
    id: documents.id,
    title: documents.title,
    content: documents.content,
    similarity: sql<number>`1 - (${documents.embedding} <=> ${queryEmbedding})`,
  })
  .from(documents)
  .where(eq(documents.category, 'brand-guidelines'))
  .orderBy(sql`${documents.embedding} <=> ${queryEmbedding}`)
  .limit(5);
```

**Prisma** also supports pgvector via `prisma-extension-pgvector` or raw queries, but Drizzle's SQL-level composability makes hybrid queries more natural.

### Handling updates

Documents change frequently (weekly meeting notes, updated strategy docs). pgvector handles this well:

- `INSERT` or `UPDATE` the row and its embedding -- standard SQL.
- No index rebuild needed at this scale (no index needed at all).
- Re-embedding a document on update is the main cost -- one API call per updated doc.
- A simple `updatedAt` column plus a cron job that re-embeds stale documents is sufficient.

### Verdict

**Strong recommendation for this use case.** Zero additional infrastructure, trivial at this scale, excellent hybrid search, good TypeScript support, and you're already paying for the Postgres instance.

---

## 2. Dedicated Vector Databases

### Pinecone

- **Free tier:** 1 index, 100K vectors, ~2GB storage. Sufficient for this use case.
- **Paid:** Serverless starts at ~$0.33/1M reads. Extremely cheap at 200 queries/day.
- **Pros:** Managed, fast, metadata filtering, good TypeScript SDK (`@pinecone-database/pinecone`).
- **Cons:** External dependency. Another service to manage, another API key, another point of failure. Data lives outside your Railway stack. Namespace/index management adds operational complexity.

### Weaviate

- **Free tier:** Weaviate Cloud has a free sandbox (14-day expiry, then you need to pay). Not suitable for production.
- **Paid:** Serverless starts ~$25/month minimum.
- **Pros:** Built-in vectorization (can call OpenAI for you), GraphQL API, hybrid search.
- **Cons:** Most expensive option. Heavy for this scale. The "built-in vectorization" adds vendor coupling.

### Qdrant

- **Free tier:** Qdrant Cloud has a free 1GB cluster (persistent, no expiry). Good for this scale.
- **Self-hosted:** Can run as a Docker container on Railway, but that's another service to manage.
- **Pros:** Excellent filtering, fast, good TypeScript client (`@qdrant/js-client-rest`), payload storage.
- **Cons:** Same as Pinecone -- external dependency, separate infrastructure.

### Chroma

- **Free tier:** Chroma Cloud launched with a generous free tier (~1M embeddings).
- **Self-hosted:** Easy to run in Docker, but again, another Railway service.
- **Pros:** Python-first but has a JS client, simple API, good for prototyping.
- **Cons:** Least mature of the four. TypeScript client is secondary. Production readiness has been questioned.

### Verdict on dedicated vector DBs

**Over-engineered for this use case.** At <1000 documents and <200 queries/day, you gain nothing over pgvector except operational complexity. The advantages of dedicated vector DBs (billion-scale indexing, multi-tenancy, real-time index updates at scale) are irrelevant here.

The only scenario where a dedicated vector DB makes sense is if you need features pgvector lacks (e.g., Pinecone's `sparse-dense` hybrid search or Weaviate's built-in reranking). At this scale, you can do reranking in application code cheaply.

---

## 3. Structured Retrieval Without Vectors

### How the previous project worked

Documents synced from Dropbox were categorized by folder:
- `00-brand/` -- brand philosophy, voice guidelines
- `01-strategy/` -- revenue goals, strategic direction
- `02-creative/` -- ad campaign philosophy, creative briefs
- etc.

Retrieval was by category match: "I need brand context" -> fetch all docs in `00-brand/`.

### Strengths

- Dead simple. No embeddings, no vector math, no embedding API costs.
- Deterministic. Same category query always returns the same docs.
- Easy to debug. "Why did it retrieve this?" -> "Because it's in the brand folder."
- Works well for structured queries: "give me the brand guidelines" maps cleanly to a category.

### Weaknesses

- **Fails on cross-cutting queries.** "What did CTC say about our subscription ROAS?" touches meeting notes, strategy, and ad performance. Which folder?
- **Fails on nuanced relevance.** Within a category, all documents are treated equally. A 6-month-old meeting note is weighted the same as last week's.
- **Fails on natural language.** Users ask questions in natural language; keyword/category matching requires them to think in terms of the system's taxonomy.
- **Scaling the taxonomy is painful.** As document types grow, you end up with overlapping categories or a deep hierarchy that's hard to maintain.

### Verdict

**Insufficient as the sole retrieval strategy**, but the category structure is valuable metadata for hybrid approaches. Don't throw away the folder taxonomy -- use it as a filtering dimension alongside vector search.

---

## 4. Hybrid: Metadata Filtering + Vector Similarity

### The recommended approach

This combines the strengths of approaches 1 and 3. The implementation:

1. **Store documents with both embeddings AND category/type metadata** in Postgres with pgvector.
2. **For each query, determine if a category filter applies** (either explicitly or via a lightweight classifier).
3. **Filter by metadata first, then rank by vector similarity** within the filtered set.
4. **Fall back to unfiltered vector search** if the metadata filter returns too few results.

### Schema design

```typescript
export const documents = pgTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull(),

  // Metadata for structured filtering
  category: text('category').notNull(),
    // 'brand', 'strategy', 'creative', 'meeting-notes',
    // 'product', 'testimonials', 'email-sms', 'video', 'style'
  subcategory: text('subcategory'),
  source: text('source'),           // 'dropbox', 'manual', 'api'
  sourceFile: text('source_file'),   // original filename/path
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  documentDate: timestamp('document_date'), // when the content is from (meeting date, etc.)

  // Vector for semantic search
  embedding: vector('embedding', { dimensions: 1536 }),

  // Full text for keyword search fallback
  // Postgres tsvector for BM25-style keyword matching
  searchVector: sql`tsvector`,
});
```

### Query strategy

```typescript
async function retrieveContext(
  query: string,
  options?: { category?: string; limit?: number; recencyBias?: boolean }
): Promise<Document[]> {
  const queryEmbedding = await embedQuery(query);
  const limit = options?.limit ?? 5;

  let baseQuery = db
    .select({
      id: documents.id,
      title: documents.title,
      content: documents.content,
      category: documents.category,
      similarity: sql<number>`1 - (${documents.embedding} <=> ${queryEmbedding})`,
    })
    .from(documents);

  // Apply category filter if specified
  if (options?.category) {
    baseQuery = baseQuery.where(eq(documents.category, options.category));
  }

  // Apply recency bias for meeting notes and evolving content
  if (options?.recencyBias) {
    baseQuery = baseQuery.orderBy(
      sql`(1 - (${documents.embedding} <=> ${queryEmbedding})) * 0.7
          + (1.0 / (1 + EXTRACT(EPOCH FROM (NOW() - ${documents.documentDate})) / 86400 / 30)) * 0.3`
    );
  } else {
    baseQuery = baseQuery.orderBy(sql`${documents.embedding} <=> ${queryEmbedding}`);
  }

  return baseQuery.limit(limit);
}
```

### Why this works for the marketing domain

| Query | Strategy |
|-------|----------|
| "What brand guidelines apply to holiday emails?" | Filter: `category = 'brand'`, rank by similarity to "holiday emails" |
| "What did CTC say about subscription ROAS?" | No filter (cross-cutting), rank by similarity, recency bias on |
| "Current revenue goals" | Filter: `category = 'strategy'`, rank by similarity, recency bias on |
| "Customer quotes about product quality" | Filter: `category = 'testimonials'`, rank by similarity |
| "What fonts do we use?" | Filter: `category = 'style'`, rank by similarity |

### Automatic category detection

For queries where the user doesn't specify a category, you can either:

1. **Let the LLM decide** -- Include a tool/function that takes a category parameter, and the LLM will route appropriately based on the query.
2. **Multi-category retrieval** -- Retrieve top-K from each relevant category, then merge and re-rank. At <1000 docs, retrieving from all categories and ranking globally is also fine.

### Verdict

**This is the recommended approach.** It preserves the value of the existing folder-based taxonomy while adding semantic understanding. pgvector in your existing Railway Postgres keeps infrastructure simple.

---

## 5. Anthropic Prompt Caching (Context Stuffing)

### How it works

Anthropic's prompt caching lets you cache a prefix of your prompt (system prompt, reference documents) and reuse it across requests. Cached tokens are charged at a significantly reduced rate:

- **Cache write:** 25% more than base input token price (one-time cost when the cache is created)
- **Cache read (hit):** 90% cheaper than base input token price
- **Cache TTL:** 5 minutes by default, extended with each hit. Frequently-used caches stay warm.

For Claude Sonnet: base input is $3/MTok, cached reads are $0.30/MTok. For Claude Haiku: base input is $0.25/MTok, cached reads are $0.025/MTok.

### Could you skip RAG entirely?

At <1000 documents, let's do the math:

- Average marketing document: ~500-2000 words -> ~700-2500 tokens
- 1000 documents at ~1500 tokens average = **1.5M tokens**
- Claude's context window: 200K tokens (Sonnet/Opus)

So **no, you cannot stuff all documents into the context window**. 1000 documents at typical length would exceed the 200K token limit by 7-8x.

However, you could use prompt caching strategically for **subsets**:

- **Brand bible (~20 docs, ~30K tokens):** Cache the full brand guidelines, voice rules, font/color specs as a permanent system prompt prefix. These rarely change and are needed for almost every generation task.
- **Current strategy context (~10 docs, ~15K tokens):** Cache current revenue goals, active campaign strategies. Update weekly.
- **Dynamic retrieval for the rest:** Use RAG (pgvector) for meeting notes, testimonials, specific product info -- the long tail that's too large to cache and not needed for every query.

### Hybrid: Caching + RAG

The optimal architecture:

```
[Cached prefix: ~40K tokens]
  - Brand philosophy & voice (always needed)
  - Current strategic direction
  - Style specifications
  - Active campaign parameters

[RAG-retrieved context: ~5-10K tokens]
  - Relevant meeting notes (pgvector similarity search)
  - Relevant testimonials
  - Specific product info
  - Historical campaign data

[User query + instructions]
```

This gives you:
- **Brand consistency:** Every generation has the full brand context, always.
- **Cost efficiency:** The cached 40K tokens cost ~$0.012/query on Sonnet (vs. $0.12 uncached). At 200 queries/day, that's $2.40/day vs $24/day.
- **Relevance:** Dynamic RAG retrieval for the specific context needed per query.

### Verdict

**Not a replacement for RAG, but a powerful complement.** Cache the stable, universally-needed context; RAG-retrieve the dynamic, query-specific context. This is the architecture to build.

---

## Embedding Model Choice

Anthropic does not offer an embeddings API. You need a third-party model.

### Options

| Model | Dimensions | Cost per 1M tokens | Notes |
|-------|-----------|-------------------|-------|
| **OpenAI text-embedding-3-small** | 1536 (configurable down to 256) | $0.02 | Best value. Strong performance. Dimensionality reduction via `dimensions` param. |
| **OpenAI text-embedding-3-large** | 3072 (configurable) | $0.13 | Marginally better quality, 6.5x the cost. Not worth it at this scale. |
| **Cohere embed-v3** | 1024 | $0.10 | Good multilingual support. Built-in `input_type` parameter (query vs document). |
| **Voyage AI voyage-3** | 1024 | $0.06 | Strong retrieval benchmarks. Good for code + text. |
| **Open-source (via Hugging Face)** | Varies | Free (compute cost) | e.g., `BAAI/bge-small-en-v1.5` (384d), `nomic-embed-text-v1.5` (768d). Requires self-hosting. |

### Recommendation: OpenAI text-embedding-3-small

- **Cost at your scale:** 1000 documents * ~1500 tokens = 1.5M tokens to embed = **$0.03 total** for the initial embedding. Re-embedding 50 docs/week costs fractions of a cent.
- **Query embeddings:** 200 queries/day * ~50 tokens = 10K tokens/day = **$0.0002/day**. Effectively free.
- **Quality:** Excellent for English marketing content. MTEB benchmark scores are competitive with models 5-10x the cost.
- **Dimensionality:** Use the default 1536 dimensions. At <1000 docs, storage is irrelevant (~6MB total). If you want to reduce, `dimensions: 512` retains ~97% quality.
- **TypeScript:** `openai` npm package is well-maintained, types are excellent.

```typescript
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}
```

### Why not self-host?

Running an embedding model on Railway would require a GPU-capable service or a CPU-based model that's slower. At $0.03 to embed your entire corpus, the API cost is negligible. Self-hosting adds infrastructure complexity for zero cost savings.

---

## Chunking Strategy

Different document types in the knowledge base need different chunking approaches.

### Document-type-specific chunking

| Document Type | Chunking Strategy | Chunk Size | Rationale |
|---------------|------------------|------------|-----------|
| **Brand philosophy / voice guidelines** | Keep whole or split by section heading | 500-1500 tokens | These are reference docs -- each section is a self-contained rule. Splitting mid-section loses meaning. |
| **Meeting notes (CTC)** | Split by topic/agenda item, with meeting date + attendees prepended to each chunk | 300-800 tokens | Meeting notes are naturally structured by topic. Each chunk should be independently useful: "On [date], CTC discussed [topic]: [content]" |
| **Product information** | One chunk per product or per product attribute group | 200-500 tokens | Product info is highly structured. Keep related attributes together (price + description + materials). |
| **Ad campaign philosophy** | Split by principle/concept | 500-1000 tokens | Similar to brand guidelines -- each principle stands alone. |
| **Customer testimonials** | One chunk per testimonial | 100-300 tokens | Each testimonial is atomic. Include customer name/context as metadata. |
| **Email/SMS calendars** | One chunk per campaign/send | 200-400 tokens | Each calendar entry is a discrete event. Include date as metadata for recency filtering. |
| **Video editing guidelines** | Split by section/rule | 300-800 tokens | Reference material, section-based. |
| **Font/color/style specs** | Keep whole (usually small) | 200-500 tokens | These are typically concise reference docs. One chunk is sufficient. |

### Chunking implementation

```typescript
interface Chunk {
  content: string;
  metadata: {
    documentId: string;
    title: string;
    category: string;
    chunkIndex: number;
    totalChunks: number;
    documentDate?: Date;
    // Prepended context so each chunk is self-contained
    contextPrefix: string; // e.g., "From CTC meeting notes (2025-06-15):"
  };
}
```

### Key principles

1. **Prepend context to every chunk.** A chunk that says "They recommended increasing spend by 20%" is useless without knowing who "they" is and when. Prepend: "From CTC meeting notes (2025-06-15): They recommended increasing spend by 20%."

2. **Overlap between chunks.** Use 10-20% overlap between adjacent chunks from the same document to avoid losing context at boundaries. For a 500-token chunk, overlap ~75 tokens.

3. **Don't chunk small documents.** If a document is under 500 tokens, store it as a single chunk. Most testimonials, style specs, and product entries fall here.

4. **Use markdown structure.** Since the previous system synced markdown files from Dropbox, use heading-based splitting (split on `##` or `###`) as the primary strategy for longer documents.

### Recommended library

**LangChain's text splitters** are available in TypeScript (`@langchain/textsplitters`) and support:
- `RecursiveCharacterTextSplitter` -- general purpose, respects paragraph/sentence boundaries
- `MarkdownTextSplitter` -- splits on markdown headings, ideal for your Dropbox-synced docs
- Custom separators for domain-specific formats

Alternatively, a simple heading-based splitter is ~30 lines of TypeScript and avoids the LangChain dependency:

```typescript
function chunkByHeadings(
  markdown: string,
  maxTokens: number = 500
): string[] {
  const sections = markdown.split(/(?=^#{1,3}\s)/m);
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    if (estimateTokens(current + section) > maxTokens && current) {
      chunks.push(current.trim());
      current = section;
    } else {
      current += section;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
```

---

## Recommended Architecture

### Summary

Use **pgvector in your existing Railway Postgres** with **hybrid metadata + vector retrieval**, complemented by **Anthropic prompt caching** for stable brand context.

```
                    ┌──────────────────────────────┐
                    │  Anthropic Claude API         │
                    │  (cached prefix: brand bible) │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────┴───────────────────┐
                    │  Application (Railway)        │
                    │                               │
                    │  1. Receive user query         │
                    │  2. Embed query (OpenAI)       │
                    │  3. Retrieve context (pgvector)│
                    │  4. Assemble prompt            │
                    │  5. Call Claude (cached prefix  │
                    │     + retrieved context)        │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────┴───────────────────┐
                    │  Railway Postgres + pgvector   │
                    │                               │
                    │  documents table:              │
                    │  - content, title, category    │
                    │  - embedding (vector 1536)     │
                    │  - metadata (source, date)     │
                    └───────────────────────────────┘
```

### Implementation steps

1. **Enable pgvector** on your Railway Postgres: `CREATE EXTENSION IF NOT EXISTS vector;`
2. **Define the documents table** with Drizzle, including `vector(1536)` column and category/metadata columns.
3. **Build the ingestion pipeline:** Sync markdown files from Dropbox (as before), chunk them by type, embed with OpenAI `text-embedding-3-small`, store in Postgres.
4. **Build the retrieval function:** Accept a query + optional category filter, embed the query, run hybrid SQL (metadata filter + cosine similarity), return top-K chunks.
5. **Set up prompt caching:** Cache the brand bible and current strategy as the system prompt prefix. This stays warm across queries.
6. **Assemble the prompt:** Cached brand context + RAG-retrieved relevant context + user query.

### Costs (monthly estimate at 200 queries/day)

| Component | Monthly Cost |
|-----------|-------------|
| OpenAI embeddings (queries) | ~$0.01 |
| OpenAI embeddings (re-indexing ~50 docs/week) | ~$0.01 |
| Anthropic Claude (with prompt caching) | Depends on model, but caching saves ~80% on the brand context portion |
| Railway Postgres | Already paying for it |
| Dedicated vector DB | $0 (not needed) |
| **Total additional cost for RAG** | **~$0.02/month for embeddings** |

### What not to do

- **Don't add Pinecone/Weaviate/Qdrant.** Zero benefit at this scale, added infrastructure.
- **Don't self-host an embedding model.** API costs are negligible; self-hosting adds complexity.
- **Don't use LangChain's full RAG pipeline.** It adds a heavy dependency for functionality you can implement in ~200 lines of TypeScript with Drizzle + OpenAI SDK. Use their text splitter if you want, but not the full chain/retriever abstraction.
- **Don't over-index on chunk size optimization.** At <1000 docs, you can afford to retrieve 10-20 chunks and let Claude sort out relevance. Precision of chunking matters less when your corpus is small.
- **Don't build a complex re-ranking pipeline.** At this scale, cosine similarity from a good embedding model is sufficient. Re-ranking (Cohere Rerank, cross-encoder models) adds latency and cost for marginal gain at <1000 docs.

---

## Comparison Matrix

| Criterion | pgvector (hybrid) | Dedicated Vector DB | Structured Only | Prompt Caching Only |
|-----------|-------------------|--------------------|-----------------|--------------------|
| Retrieval quality | High (semantic + metadata) | High (semantic + metadata) | Low (exact match only) | N/A (not retrieval) |
| Infrastructure simplicity | Excellent (existing Postgres) | Poor (new service) | Excellent | Excellent |
| Cost | ~$0 additional | $0-25/month | $0 | Reduces LLM costs |
| Handles cross-cutting queries | Yes | Yes | No | N/A |
| Handles natural language | Yes | Yes | No | N/A |
| TypeScript ecosystem | Good (Drizzle) | Good (vendor SDKs) | Trivial | N/A |
| Update handling | Simple (upsert + re-embed) | Simple (API call) | Simple (upsert) | Manual cache invalidation |
| Scales beyond 1K docs | Yes (to ~100K easily) | Yes (to millions) | Becomes unwieldy | No (context window limit) |

## Final Recommendation

**pgvector with hybrid metadata+vector retrieval, plus Anthropic prompt caching for the brand bible.**

This is the "boring technology" choice, and that's the right call for a single-brand platform. You get:

- Semantic search quality comparable to any dedicated vector DB at this scale
- Zero new infrastructure -- pgvector is an extension on your existing Railway Postgres
- Hybrid queries that combine the folder-based taxonomy from the previous project with semantic ranking
- Prompt caching to keep brand context warm and cheap
- Total embedding cost under $1/year
- A system you can implement in a day and maintain with near-zero operational overhead

The only reason to revisit this decision is if the document count grows past ~50K or you need multi-tenant vector isolation -- neither of which is on the horizon for a single-brand platform.
