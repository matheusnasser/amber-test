# CLAUDE.md

## Project

AI-powered supplier negotiation system. A brand sourcing manager uploads messy XLSX quotations, the system parses them into structured data, matches against a 10K product catalog, then AI agents negotiate with 3 suppliers to find the best deal — including handling mid-negotiation disruptions.

**See `design-document.md` for full architecture, schema, and implementation details.**

## Architecture

```
apps/api    → Express (port 4000) — ALL business logic, DB access, LLM calls
apps/web    → Next.js (port 3000) — UI only, calls API via services/api-client.ts
packages/database → Prisma schema, client, migrations, seed
packages/shared   → Shared TypeScript types and supplier constants
```

- **No API routes in Next.js.** Every endpoint lives in `apps/api/src/routes/`.
- **No business logic in Next.js.** The frontend only renders UI and calls the API.
- `apps/web/src/services/api-client.ts` is the sole bridge between frontend and backend.

## Core Principles

### I. Entity-Driven Architecture
Every data concept is a first-class database entity with proper foreign keys — not config files, hardcoded constants, or JSON blobs. The Prisma schema in `packages/database/prisma/schema.prisma` is the single source of truth.

- All entities MUST include `organizationId` for multi-tenant scoping.
- Relationships use proper `@relation` directives, never store IDs as plain strings.
- Supplier performance metrics (`onTimeDeliveryRate`, `defectRate`, `responseTimeDays`) live on the Supplier entity.
- PurchaseOrder allocations include landed cost fields (`fobCost`, `cashFlowCost`, `estimatedFreight`, `estimatedDuty`, `effectiveLandedCost`).

### II. LLM Reliability & Structured Output
Every LLM response MUST be validated against a Zod schema before use. Unvalidated LLM output MUST NOT be written to the database or drive downstream logic.

- Use the **Vercel AI SDK** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) as the unified orchestration layer for ALL LLM calls.
- `generateObject()` for structured output (auto Zod validation).
- `generateText()` for free-form text responses.
- `streamText()` for SSE streaming.
- **Model assignments (do not mix):**
  - Haiku (`anthropic('claude-haiku-4-5-20251001')`) → XLSX parsing, validation, matching fallback (fast, cheap, structured extraction)
  - GPT-4o (`openai('gpt-4o')`) → agent conversations, offer extraction (needs reasoning)
- Model config lives in `apps/api/src/lib/ai.ts` — swap models with a one-line change.
- For large inputs (grids > 50 rows), chunk with header repetition and merge/deduplicate.
- Every LLM call MUST be wrapped in try/catch with descriptive error context (which phase, which supplier, which round).

### III. Human-in-the-Loop at Decision Points
The system MUST require human confirmation before irreversible actions. Automation prepares; humans approve.

- HIL is **conditional**: if all items match at confidence >= 0.85 and no validation flags, auto-proceed. Only surface items that need attention.
- PurchaseOrders are ALWAYS created in `draft` status. Transitioning to `confirmed` requires explicit user action — never auto-confirm.
- The curveball phase does NOT trigger automatically — the user initiates it.

### IV. Multi-Tenant Data Isolation
Every Prisma query MUST include `organizationId` in the `where` clause. For the demo, a hardcoded default org is acceptable, but the plumbing MUST exist.

### V. Streaming-First Agent Communication
`/api/negotiate` and `/api/curveball` return SSE streams via `res.write()`. Messages are persisted to the database as they are generated, not batched at the end.

### VI. Simplicity & YAGNI
Build only what the design document specifies. No premature abstractions. Three similar lines of code are preferable to a premature abstraction. The project has a 3-day build window.

## Product Matching Strategy

Cheapest first, LLM only as last resort:

1. **Tier 1: Exact SKU** — Map lookup, case-insensitive — free, instant
2. **Tier 2: Fuzzy SKU** — fuse.js with threshold 0.4 — free, instant
3. **Tier 3: Product Name** — fuse.js name index, confidence capped at 0.7x — free, instant
4. **Tier 4: LLM Fallback** — Haiku via `generateObject`, only unmatched items (~5%) — cheap
5. **Tier 5: Unmatched** — confidence 0, flagged in UI

Confidence thresholds: >= 0.85 auto-accept | 0.5-0.84 review | < 0.5 action needed

## Negotiation Memory

- **Store everything** in DB (every message, every extracted offer, every analysis).
- **Retrieve selectively** for LLM context:
  - Current supplier: FULL conversation history
  - Other suppliers: ONLY latest structured offer summary (~200 tokens each)
  - Static: baseline quotation, user notes, supplier profiles

## Message Formatting Standards

All agent messages use **consistent SKU/product reference formatting** for readability and parsability.

### Standard Format
**`sku(description)`** with no space before the parenthesis.

**Examples:**
- ✅ `MB013-0BS-XL(Insulated Winter Jacket)`
- ✅ `MB015-RED-M(Fleece Pullover)`
- ❌ `Insulated Winter Jacket (ref: MB013-0BS-XL)` - old format
- ❌ `MB013-0BS-XL: Insulated Winter Jacket` - old format

### Implementation
**Always use the centralized helper functions** from `apps/api/src/agents/format-helpers.ts`:

```typescript
formatSkuRef(sku, description)
// Returns: "MB013-0BS-XL(Insulated Winter Jacket)"

formatItemList(items, includePrice?)
// Returns formatted multi-line list
```

**Never manually concatenate SKU + description.** The helpers ensure consistency across:
- Brand Agent quote requests
- Supplier Agent baseline item lists
- Context builder quotation tables
- Offer extraction prompts
- Negotiation graph XLSX summaries

## Tech Stack (locked — do not substitute)

| Layer | Technology | Location |
|-------|-----------|----------|
| Monorepo | Turborepo | root `turbo.json` |
| Frontend | Next.js 14 App Router | `apps/web` |
| API | Express + TypeScript | `apps/api` |
| Database | PostgreSQL 16 (Docker) | `docker-compose.yml` |
| ORM | Prisma | `packages/database` |
| XLSX parsing | exceljs | `apps/api/src/parser` |
| LLM orchestration | Vercel AI SDK (`ai`) | `apps/api/src/lib/ai.ts` |
| LLM (parsing + validation) | Haiku via `@ai-sdk/anthropic` | `apps/api/src/parser` |
| LLM (agents) | GPT-4o via `@ai-sdk/openai` | `apps/api/src/agents` |
| Fuzzy matching | fuse.js | `apps/api/src/matcher` |
| Styling | Tailwind CSS | `apps/web` |

## Code Style

- TypeScript strict mode across all packages
- Async/await for all async operations (no `.then` chains)
- Descriptive variable names (no single-letter abbreviations outside loop counters)
- Every LLM call wrapped in try/catch
- Console.log timing for LLM calls in development

## Commands

```bash
docker-compose up -d          # Start PostgreSQL
npm run db:migrate             # Run Prisma migrations
npm run db:seed                # Seed 10K products + 3 suppliers + 1 org
npm run dev                    # Start both API (4000) and web (3000)
npm run db:studio              # Prisma Studio for data inspection
npx turbo build                # Must pass with zero errors
```

## Critical Path

The XLSX parser MUST work with unknown spreadsheet formats. This is the first thing evaluators will test. If time is limited, parser resilience takes priority over UI polish.
