# Supplier Negotiation System — Design Document

---

## 1. What Are We Building?

A system where a brand sourcing manager:

1. **Uploads** a messy XLSX quotation from a supplier
2. **System parses** it into structured data and matches against a 10K product catalog
3. **AI agents negotiate** with 3 suppliers to find the best deal
4. **Handles a curveball** mid-negotiation (Supplier 2 can only do 60%)
5. **Recommends** the best supplier(s) with clear reasoning
6. **Tracks AI costs** for full transparency on LLM spend

---

## 2. The Full Flow (What Happens Step by Step)

```
USER UPLOADS XLSX
        │
        ▼
┌──────────────────────────────────────────┐
│  PHASE 1: PARSE & MATCH                  │
│                                          │
│  1. exceljs reads the file               │
│     - Unmerges cells                     │
│     - Flattens to a 2D grid of strings   │
│     - Marks which cells are bold         │
│                                          │
│  2. Claude Haiku (LLM) interprets grid   │
│     - "Which rows are headers?"          │
│     - "Which rows are products?"         │
│     - Extracts: SKU, description,        │
│       quantity, unit price, total, notes  │
│     - Extracts: sheet-level metadata     │
│       (supplier name, payment terms,     │
│        lead time, currency, incoterm)    │
│     - If grid is big, chunk it (80 rows) │
│     - Post-extraction discount fix       │
│                                          │
│  3. Claude Haiku validates extraction    │
│     - Cross-checks prices, quantities    │
│     - Arithmetic validation              │
│     - Flags discrepancies for HIL        │
│                                          │
│  4. Product matcher resolves products    │
│     - Tier 1: Exact SKU (free)           │
│     - Tier 1.5: OCR-normalized SKU       │
│     - Tier 2: Fuzzy SKU via fuse.js      │
│     - Tier 3: Product name via fuse.js   │
│     - Tier 4: LLM fallback (Haiku)       │
│     - Tier 5: Unmatched → flagged        │
│                                          │
│  5. Supplier identification              │
│     - LLM extracts supplier name from    │
│       XLSX headers/metadata              │
│     - Fuzzy-matches against DB suppliers │
│     - User confirms or creates new       │
│                                          │
│  OUTPUT: List of parsed items with       │
│  matched products + confidence scores +  │
│  pricing tiers + supplier identification │
└──────────────────┬───────────────────────┘
                   │
                   ▼ User reviews parsed items
                     (HIL: confirm matches, select candidates)
                   │
                   ▼ User adds notes, selects max rounds (1-5, default 4)
                   │
                   ▼
┌──────────────────────────────────────────┐
│  PHASE 2: NEGOTIATE (4 rounds default)   │
│                                          │
│  Brand Agent (3-pillar architecture)     │
│  talks to 3 suppliers via LangGraph:     │
│                                          │
│  ┌─ SUP-001 (from XLSX) ──────────────┐ │
│  │  Quality: 4.0 | Price: Cheapest    │ │
│  │  Lead: 50 days | Pay: 33/33/33     │ │
│  │  isSimulated: false                │ │
│  │                                    │ │
│  │  Round 1: Baseline offer presented │ │
│  │  Round 2+: Full negotiation        │ │
│  └────────────────────────────────────┘ │
│                                          │
│  ┌─ SUP-002 (simulated) ─────────────┐  │
│  │  Quality: 4.7 | Price: Expensive  │  │
│  │  Lead: 25 days | Pay: 40/60       │  │
│  │  isSimulated: true                │  │
│  │                                   │  │
│  │  Round 1: Quote request (RFQ)     │  │
│  │  Round 2+: Full negotiation       │  │
│  └────────────────────────────────────┘ │
│                                          │
│  ┌─ SUP-003 (simulated) ─────────────┐  │
│  │  Quality: 4.0 | Price: Mid-range  │  │
│  │  Lead: 15 days | Pay: 100% upfront│  │
│  │  isSimulated: true                │  │
│  │                                   │  │
│  │  Round 1: Quote request (RFQ)     │  │
│  │  Round 2+: Full negotiation       │  │
│  └────────────────────────────────────┘ │
│                                          │
│  KEY: After each supplier responds,      │
│  we extract their offer as structured    │
│  data. Brand Agent references OTHER      │
│  suppliers' offers when negotiating.     │
│                                          │
│  Round 1 strategy: S2/S3 quote first,   │
│  then S1 enters with their offers as    │
│  competitive leverage.                   │
│                                          │
│  OUTPUT: Conversations + structured      │
│  offers + scored comparisons             │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  PHASE 3: CURVEBALL (auto after R1)      │
│                                          │
│  System injects after Round 1:           │
│  "SUP-002 can only fulfill 60%"          │
│                                          │
│  Decision Maker analyzes:                │
│  - Impact assessment                     │
│  - 2-3 strategy proposals                │
│  - Supplier allocation recommendations   │
│                                          │
│  Post-curveball renegotiation rounds:    │
│  - Phase: "post_curveball"               │
│  - All previous data preserved           │
│  - Curveball constraint injected into    │
│    SUP-002's supplier agent prompt       │
│                                          │
│  OUTPUT: Updated offers + new strategy   │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  PHASE 4: FINAL DECISION                 │
│                                          │
│  Decision Maker evaluates all offers:    │
│                                          │
│  - Deterministic scoring (0-100)         │
│  - Multi-dimensional comparison          │
│    (cost, quality, lead time, terms)     │
│  - Cash flow impact analysis             │
│  - Recommendation + reasoning            │
│  - Trade-off explanation                 │
│  - Split-order overhead evaluation       │
│                                          │
│  Creates PurchaseOrder (status: draft)   │
│  with per-supplier allocations +         │
│  per-item line items + landed costs      │
│                                          │
│  OUTPUT: Decision + PO + comparison      │
└──────────────────────────────────────────┘
```

---

## 3. Tech Stack

| Component         | Tech                                  | Version   | Location                      |
| ----------------- | ------------------------------------- | --------- | ----------------------------- |
| Monorepo          | Turborepo                             | 2.3.0     | root `turbo.json`             |
| Language          | TypeScript (strict)                   | 5.7.0     | all packages                  |
| Frontend          | Next.js 14 (App Router)               | 14.2.0    | `apps/web`                    |
| Frontend UI       | React                                 | 18.3.0    | `apps/web`                    |
| Styling           | Tailwind CSS                          | 3.4.0     | `apps/web`                    |
| Animations        | Framer Motion                         | 12.33.0   | `apps/web`                    |
| Charts            | Recharts                              | 2.15.0    | `apps/web`                    |
| Flow Viz          | @xyflow/react (ReactFlow)             | 12.10.0   | `apps/web`                    |
| Markdown          | react-markdown                        | 10.1.0    | `apps/web`                    |
| API               | Express                               | 4.21.0    | `apps/api`                    |
| Database          | PostgreSQL 16 (Docker, port 5433)     | 16        | `docker-compose.yml`          |
| ORM               | Prisma                                | 6.3.0     | `packages/database`           |
| LLM SDK (parsing) | Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) | 4.0.0 | `apps/api/src/lib/ai.ts`      |
| LLM SDK (agents)  | LangChain (`@langchain/anthropic`, `@langchain/langgraph`) | 1.3.15 / 1.1.4 | `apps/api/src/agents` |
| LLM (fast tasks)  | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | —  | pillars, extraction, parsing  |
| LLM (reasoning)   | Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) | — | agents, decisions             |
| XLSX parsing      | exceljs                               | 4.4.0     | `apps/api/src/parser`         |
| Fuzzy matching    | fuse.js                               | 7.1.0     | `apps/api/src/matcher`        |
| Validation        | zod                                   | 3.23.8    | throughout                    |
| File uploads      | multer                                | 1.4.5     | `apps/api`                    |
| Auth              | jsonwebtoken + bcryptjs               | 9.0.3 / 3.0.3 | `apps/api/src/lib/auth.ts` |

### Model Assignments

| Use Case                | Model        | SDK                | Why                                         |
| ----------------------- | ------------ | ------------------- | ------------------------------------------- |
| XLSX grid → structured  | Haiku 4.5    | Vercel AI SDK `generateObject()` | Fast, cheap, reliable structured extraction |
| Extraction validation   | Haiku 4.5    | Vercel AI SDK `generateObject()` | Verification doesn't need reasoning         |
| Product matching fallback| Haiku 4.5   | Vercel AI SDK `generateObject()` | Classification task, batch-friendly         |
| Offer extraction        | Haiku 4.5    | Vercel AI SDK `generateObject()` | Structured output, schema-validated         |
| Brand Agent pillars (×3)| Haiku 4.5    | LangChain `ChatAnthropic` | Fast parallel analysis, avoids rate limits  |
| Brand Agent synthesizer | Haiku 4.5    | LangChain `ChatAnthropic` | Merges pillar briefs into single message    |
| Supplier Agent responses| Sonnet 4.5   | LangChain `ChatAnthropic` | Personality + realistic counter-negotiation |
| Curveball analysis      | Sonnet 4.5   | Vercel AI SDK `generateObject()` | Complex reasoning + structured output       |
| Final decision          | Sonnet 4.5   | Vercel AI SDK `generateObject()` | Complex reasoning + structured output       |

---

## 4. Project Structure

```
supplier-negotiation/
├── docker-compose.yml              # PostgreSQL 16 (port 5433)
├── package.json                    # Workspace root
├── turbo.json                      # Turborepo pipeline
├── .env                            # API keys + DATABASE_URL (gitignored)
├── .env.example                    # Environment template
├── CLAUDE.md                       # Architecture rules
├── design-document.md              # This file
│
├── packages/
│   ├── database/                   # Prisma schema + client + seed
│   │   ├── prisma/
│   │   │   ├── schema.prisma       # 11 entity models
│   │   │   ├── seed.ts             # 1 org + 2 simulated suppliers + 10K products
│   │   │   └── migrations/
│   │   └── src/
│   │       └── index.ts            # PrismaClient singleton
│   │
│   └── shared/                     # Shared types + scoring
│       └── src/
│           ├── index.ts            # Re-exports
│           ├── types.ts            # Core TypeScript interfaces
│           ├── suppliers.ts        # Supplier constants
│           └── scoring.ts          # Deterministic offer scoring (0-100)
│
├── apps/
│   ├── api/                        # Express API (port 4000)
│   │   └── src/
│   │       ├── index.ts            # Server entry, route mounting, CORS
│   │       ├── routes/
│   │       │   ├── auth.ts         # Login, session validation
│   │       │   ├── parse.ts        # XLSX upload, parsing, matching, supplier ID
│   │       │   ├── negotiate.ts    # Negotiation start/stream/state/decision/requote
│   │       │   ├── curveball.ts    # Curveball pipeline (SSE)
│   │       │   └── purchase-orders.ts  # PO confirmation
│   │       ├── middleware/
│   │       │   └── auth.ts         # JWT authentication middleware
│   │       ├── parser/
│   │       │   ├── xlsx-reader.ts      # exceljs: read, unmerge, flatten
│   │       │   ├── llm-structurer.ts   # Haiku: grid → structured items + metadata
│   │       │   └── llm-validator.ts    # Haiku: extraction validation
│   │       ├── matcher/
│   │       │   └── product-matcher.ts  # 5-tier matching pipeline
│   │       ├── agents/
│   │       │   ├── types.ts            # Agent data interfaces
│   │       │   ├── brand-agent.ts      # Brand message generator (RFQ fast path + full graph)
│   │       │   ├── brand-graph.ts      # LangGraph: 3-pillar → synthesizer
│   │       │   ├── supplier-agent.ts   # Supplier response generator (3 personalities)
│   │       │   ├── negotiation-graph.ts # LangGraph: outer negotiation orchestration
│   │       │   ├── negotiation-loop.ts # Top-level runner + post-curveball
│   │       │   ├── context-builder.ts  # Cross-agent context assembly
│   │       │   ├── offer-extractor.ts  # Structured offer extraction
│   │       │   ├── decision-maker.ts   # Curveball analysis + final decision
│   │       │   ├── format-helpers.ts   # SKU/product formatting standards
│   │       │   ├── schemas/
│   │       │   │   └── decision-schemas.ts  # Zod schemas for decision output
│   │       │   └── utils/
│   │       │       ├── calculations.ts        # Price range, cash flow math
│   │       │       ├── conversation-history.ts # History compression + trimming
│   │       │       ├── decision-helpers.ts     # Offer loading, formatting
│   │       │       ├── formatting.ts           # Currency, quotation table formatting
│   │       │       ├── product-categorization.ts # Product type inference
│   │       │       └── sku-allocation.ts       # SKU-level supplier allocation
│   │       ├── config/
│   │       │   └── business-rules.ts   # Scoring weights, pricing ranges, thresholds
│   │       └── lib/
│   │           ├── ai.ts               # Model config + semaphores + CostTracker
│   │           ├── auth.ts             # JWT generation + verification
│   │           ├── env.ts              # Environment variable loading
│   │           └── event-bus.ts        # In-memory SSE pub/sub
│   │
│   └── web/                        # Next.js frontend (port 3000)
│       └── src/
│           ├── app/
│           │   ├── layout.tsx          # Root layout + AuthGuard
│           │   ├── page.tsx            # Main workflow (4-step)
│           │   ├── login/
│           │   │   └── page.tsx        # Login page
│           │   └── orchestration/
│           │       └── page.tsx        # LangGraph visualization
│           ├── components/
│           │   ├── AuthGuard.tsx        # Authentication wrapper
│           │   ├── FileUpload.tsx       # XLSX upload + notes + max rounds
│           │   ├── ParsingLoader.tsx    # Animated parsing progress
│           │   ├── ParsedDataPreview.tsx# Parsed data overview
│           │   ├── SupplierSection.tsx  # Supplier identification/selection
│           │   ├── QuotationTable.tsx   # Product matching HIL table
│           │   ├── NegotiationPanel.tsx # Real-time negotiation UI (SSE)
│           │   ├── SupplierChat.tsx     # Chat interface
│           │   ├── CurveballAlert.tsx   # Curveball notification + strategies
│           │   ├── CashFlowInsights.tsx # Cash flow analysis
│           │   ├── FinalDecision.tsx    # Decision + PO confirmation
│           │   ├── OrchestrationFlow.tsx# ReactFlow graph visualization
│           │   └── WorkflowSidebar.tsx  # Horizontal workflow stepper
│           ├── services/
│           │   └── api-client.ts       # All API calls + SSE streaming + TypeScript types
│           └── lib/
│               └── formatting.ts       # Client-side formatting utilities
```

### Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   apps/web      │  HTTP   │   apps/api      │
│   (Next.js)     │────────→│   (Express)     │
│                 │  SSE    │                 │
│   Port 3000     │←────────│   Port 4000     │
│                 │         │                 │
│   UI only:      │         │   All logic:    │
│   - Components  │         │   - Parser      │
│   - State       │         │   - Matcher     │
│   - API client  │         │   - Agents      │
│   - Styling     │         │   - DB access   │
│                 │         │   - LLM calls   │
└─────────────────┘         └────────┬────────┘
                                     │
                            ┌────────▼────────┐
                            │   PostgreSQL    │
                            │   (Docker)      │
                            └─────────────────┘
```

- **No API routes in Next.js.** Every endpoint lives in `apps/api/src/routes/`.
- **No business logic in Next.js.** Frontend only renders UI and calls the API.
- `apps/web/src/services/api-client.ts` is the sole bridge between frontend and backend.

---

## 5. Database Schema

11 entity models, all scoped by `organizationId` for multi-tenancy.

### Entity Relationship Diagram

```
Organization (1) ──→ (N) Supplier
                 ──→ (N) Quotation
                 ──→ (N) Negotiation
                 ──→ (N) PurchaseOrder

Supplier (1) ──→ (N) Quotation
             ──→ (N) NegotiationRound
             ──→ (N) PurchaseOrderAllocation

Quotation (1) ──→ (N) QuotationItem
              ──→ (1) Negotiation

QuotationItem (N) ──→ (0..1) Product

Negotiation (1) ──→ (N) NegotiationRound
                ──→ (0..1) PurchaseOrder

NegotiationRound (1) ──→ (N) Message

PurchaseOrder (1) ──→ (N) PurchaseOrderAllocation

PurchaseOrderAllocation (1) ──→ (N) PurchaseOrderItem

PurchaseOrderItem (N) ──→ (1) Product
```

### Key Models

**Supplier** — First-class entity with profile + performance metrics + simulation flag.

| Field              | Type    | Purpose                                          |
| ------------------ | ------- | ------------------------------------------------ |
| code               | String  | Short identifier (e.g., "SUP-001")               |
| qualityRating      | Float   | 4.0, 4.7, etc.                                   |
| priceLevel         | String  | "cheapest" / "mid" / "expensive"                 |
| leadTimeDays       | Int     | Default lead time                                |
| paymentTerms       | String  | "33/33/33", "40/60", "100"                       |
| onTimeDeliveryRate | Float   | 0.92 = 92%                                       |
| defectRate         | Float   | 0.02 = 2%                                        |
| responseTimeDays   | Float   | Avg days to respond                              |
| totalOrdersCount   | Int     | Historical count                                 |
| **isSimulated**    | Boolean | `true` for AI simulation agents (SUP-002, SUP-003) |

**Product** — 10K catalog with parsed SKU components.

| Field     | Type   | Purpose                            |
| --------- | ------ | ---------------------------------- |
| sku       | String | Unique. e.g., "MC001-GLW-XL"      |
| name      | String | Product name                       |
| color     | String | Color from CSV                     |
| skuPrefix | String | Derived: "MC001"                   |
| colorCode | String | Derived: "GLW"                     |
| sizeCode  | String | Derived: "XL"                      |

**QuotationItem** — Raw + clean parsed values + match result.

| Field           | Type   | Purpose                                  |
| --------------- | ------ | ---------------------------------------- |
| rawSku          | String | As-is from XLSX                          |
| rawDescription  | String | As-is from XLSX                          |
| rawNotes        | String? | Discount info, conditions from XLSX     |
| productId       | String? | Matched product (nullable)              |
| matchConfidence | Float  | 0.0 – 1.0                               |
| matchMethod     | String? | "exact_sku" / "fuzzy_sku" / "name_match" / "llm_match" / "unmatched" |

**Negotiation** — Session with AI cost tracking.

| Field        | Type   | Purpose                                      |
| ------------ | ------ | -------------------------------------------- |
| mode         | String | "cost" / "quality" / "speed" / "cashflow" / "balanced" / "custom" |
| status       | String | "pending" → "negotiating" → "curveball" → "completed" |
| maxRounds    | Int    | Default 4. User-configurable (1-5)           |
| totalTokens  | Int    | Total tokens used across all LLM calls       |
| totalCostUsd | Float  | Estimated USD cost of AI calls               |

**NegotiationRound** — Per supplier, per round.

| Field       | Type   | Purpose                                |
| ----------- | ------ | -------------------------------------- |
| roundNumber | Int    | Sequential within supplier             |
| phase       | String | "initial" / "post_curveball"           |
| offerData   | Json?  | Structured offer (totalCost, items, leadTime, terms, concessions, conditions) |

**PurchaseOrder** + **PurchaseOrderAllocation** + **PurchaseOrderItem** — Always created as `draft`. Includes landed cost fields (fobCost, cashFlowCost, effectiveLandedCost).

### Seed Data

On `npm run db:seed`:

1. **1 Organization** — "Valden Outdoor"
2. **2 Simulated Suppliers** — SUP-002 "Alpine Premium" + SUP-003 "RapidGear Co" (`isSimulated: true`)
3. **10,052 Products** — from `data/products.csv` (brand, sku, name, color, parsed SKU components)

SUP-001 is NOT seeded — it's created dynamically when the user uploads an XLSX and the system identifies/creates the source supplier.

---

## 6. How Each Piece Works

### 6.1 XLSX Parser

**Three-stage pipeline:**

**Stage 1: Mechanical extraction** (`parser/xlsx-reader.ts`)
```
Input:  XLSX file (Buffer)
Output: XlsxWorkbook { sheets: XlsxSheet[] }
        XlsxSheet { name, grid: string[][], boldCells: [row,col][] }
```
- exceljs opens the file
- Handles merged cells (copies value to all cells in range)
- Converts all cells to strings (numbers, dates, formulas, rich text, hyperlinks, shared formulas, errors)
- Tracks bold cells (likely headers)
- Processes all worksheets

**Stage 2: LLM structuring** (`parser/llm-structurer.ts`)
```
Input:  XlsxSheet[]
Output: { items: RawParsedItem[], sheetMetadata: Map<string, SheetMetadata> }
```
- Processes all sheets in parallel
- Preprocesses grid: strips empty rows/cols
- Chunks grids > 80 rows (repeats header rows)
- Uses Haiku via `generateObject()` with Zod schema
- Extracts both items AND sheet-level metadata (supplier name, payment terms, lead time, currency, incoterm, MOQ, notes)
- Handles discounts: computes final unit price after applying discount columns
- Post-extraction discount sanity check: detects unapplied discounts via multi-tier check + individual item check
- Deduplicates within sheets

**Stage 3: LLM validation** (`parser/llm-validator.ts`)
```
Input:  XlsxSheet[] + RawParsedItem[]
Output: ValidationFlag[] { itemIndex, field, extracted, actual, issue }
```
- Arithmetic validation: `qty × unitPrice = totalPrice`, fills missing values
- LLM validation: per-sheet comparison of extracted vs raw grid
- Flags discrepancies → reduced confidence → HIL review

### 6.2 Product Matching (`matcher/product-matcher.ts`)

**5-tier matching pipeline — cheapest first, LLM only as last resort.**

| Tier   | Method          | Cost | Confidence | Handles                                     |
| ------ | --------------- | ---- | ---------- | ------------------------------------------- |
| 1      | Exact SKU       | Free | 1.0        | Correctly typed SKUs                        |
| 1.5    | OCR-normalized  | Free | 0.95       | O↔0, I↔1↔l, K↔Q swaps                      |
| 2      | Fuzzy SKU       | Free | 0.7-0.95   | Typos in SKUs                               |
| 3      | Product name    | Free | 0.5-0.7    | Quotations using names instead of SKUs      |
| 4      | LLM fallback    | ~$0.002/item | 0.6-0.9 | Garbled SKUs, unusual descriptions   |
| 5      | Unmatched       | —    | 0          | Flagged for user action                     |

**Implementation details:**
- Products loaded from DB once, cached in memory
- Builds `skuMap` (Map lookup), `skuFuse` (fuse.js), `nameFuse` (fuse.js) indexes
- OCR normalization: swaps visually similar characters before matching
- Batched LLM matching: 10 items per batch for Tier 4
- Validation penalty: -0.2 confidence if item was flagged by validator
- Returns `MatchResult` with matched product + `candidates[]` for HIL

**HIL thresholds** (from `config/business-rules.ts`):
```
confidence >= 0.85  →  Auto-accept (shown collapsed)
confidence 0.5-0.84 →  Show with ⚠️ flag, user confirms/selects candidate
confidence < 0.5    →  Show with ❌ flag, user must act
confidence = 0      →  Unmatched, user searches catalog or skips
```

### 6.3 Supplier Profiles

**SUP-001** (from XLSX — created dynamically):
- Quality: 4.0/5.0 | Price: Cheapest | Lead: 50 days | Pay: 33/33/33
- `isSimulated: false` — this is the real supplier from the uploaded quotation

**SUP-002** "Alpine Premium" (seeded, simulated):
- Quality: 4.7/5.0 | Price: Expensive | Lead: 25 days | Pay: 40/60
- `isSimulated: true`
- Personality: Premium positioning, consultative, justifies cost with quality. Small discounts (3-5% max) wrapped in partnership language. Offers non-price concessions first.

**SUP-003** "RapidGear Co" (seeded, simulated):
- Quality: 4.0/5.0 | Price: Mid-range | Lead: 15 days | Pay: 100% upfront
- `isSimulated: true`
- Personality: Speed-focused, warm, creative. Proposes alternative structures. Restructures terms instead of just dropping price.

**Pricing constraints** (from `config/business-rules.ts`):
- Cheapest: 0.85x–1.0x baseline (up to 15% discount)
- Expensive: 1.15x–1.4x baseline (15-40% premium)
- Mid-range: 0.95x–1.2x baseline (5% discount to 20% premium)

### 6.4 AI Agent Architecture

#### Brand Agent — 3-Pillar LangGraph Architecture

The Brand Agent is decomposed into 3 specialist pillars that run **in parallel**, then a synthesizer merges their outputs.

```
                    ┌──────────────────┐
                    │   Brand Agent    │
                    │  (brand-agent.ts)│
                    └────────┬─────────┘
                             │
                    ┌────────▼─────────┐
                    │   Brand Graph    │
                    │ (brand-graph.ts) │
                    │   LangGraph      │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
    ┌─────────▼──────┐ ┌────▼─────────┐ ┌──▼──────────────┐
    │  Negotiator    │ │ Risk Analyst │ │  Product/Cost   │
    │  Pillar        │ │ Pillar       │ │  Pillar         │
    │                │ │              │ │                 │
    │ Competitive    │ │ Supply chain │ │ SKU analysis    │
    │ bidding,       │ │ risk, backup │ │ Cash flow,      │
    │ leverage,      │ │ plans,       │ │ landed cost,    │
    │ FOMO           │ │ diversify    │ │ volume pricing  │
    │                │ │              │ │                 │
    │ (Haiku 4.5)   │ │ (Haiku 4.5)  │ │ (Haiku 4.5)     │
    └─────────┬──────┘ └────┬─────────┘ └──┬──────────────┘
              │              │              │
              └──────────────┼──────────────┘
                             │
                    ┌────────▼─────────┐
                    │   Synthesizer    │
                    │                  │
                    │ Merges 3 pillar  │
                    │ outputs into     │
                    │ single message   │
                    │ as "Alex"        │
                    │ (80-100 words)   │
                    │                  │
                    │ (Haiku 4.5)      │
                    └──────────────────┘
```

**Fast path:** For SUP-002/SUP-003 Round 1, a simple RFQ is sent (no pillar analysis needed — just product listing + request for quote). Uses Sonnet for the RFQ message.

**Compact pillar contexts:** Each pillar receives only the data it needs (~70% token reduction vs full context).

**Pillar events:** Each pillar emits `pillar_started` and `pillar_complete` SSE events for real-time UI visualization.

#### Supplier Agent (`supplier-agent.ts`)

- `buildSupplierSystemPrompt()` — Rich personality-based prompt including:
  - Company profile and baseline quotation (with SKU formatting)
  - Pricing constraints (multiplier ranges based on price level)
  - Quantity rules (baseline quantities + optional volume proposals)
  - Personality traits and negotiation behavior
  - Conversation memory (tracks concessions, competitor mentions, price drop history)
  - Product knowledge inference (categorizes items by keywords)
  - Curveball context when applicable
- `createSupplierResponse()` — Invokes Sonnet 4.5 with system prompt + compressed conversation history

#### Outer Negotiation Graph (`negotiation-graph.ts`)

```
START → initSuppliers → negotiateRound → checkConvergence ─┐
                              ▲                            │
                              └───── (more rounds) ────────┘
                                                          │
                                                      ── END
```

**State includes:** `negotiationId`, `quotationItems`, `supplierProfiles`, `allOffers` (Record), `conversationHistories` (Record), `previousOffers`, `currentRound`, `phase`, `maxRounds`, `mode`, `isComplete`, `quotationSupplierCode`, `curveballSupplierCode`

**Per-round behavior:**
1. **Round 1 wave strategy:** S2/S3 process first (wave 1), then S1 enters with their offers available as competitive leverage (wave 2)
2. For S1 Round 1: Baseline offer presented (from XLSX quotation data)
3. For S2/S3 Round 1: Quote request (fast-path RFQ)
4. All other rounds: Full pillar analysis → brand message → supplier response → offer extraction
5. After each round: scored offers snapshot emitted, round analysis generated
6. Curveball constraint injected into affected supplier's prompt during `post_curveball` phase

#### Negotiation Loop (`negotiation-loop.ts`)

- `runNegotiation()` — Main entry:
  - Loads quotation items + 3 suppliers (SUP-001, SUP-002, SUP-003)
  - Deduplicates items by SKU (keeps smallest qty as primary, attaches all pricing tiers)
  - Invokes `negotiationGraph`
  - Persists AI cost totals on completion
- `runPostCurveballRounds()` — Post-curveball:
  - Rebuilds existing state (offers, conversations) from database
  - Enriches user notes with curveball strategy
  - Runs graph with `phase: "post_curveball"`
  - Preserves all previous conversation history

### 6.5 Context Builder (`context-builder.ts`)

Before each Brand Agent turn, assembles the right context:

**For the current supplier:** FULL conversation history (with trimming for very long histories)
**For other suppliers:** ONLY latest structured offer summary (~200 tokens each)
**Always included:** Baseline quotation (with rawNotes for discounts, pricing tiers), user notes, supplier profiles, quality comparison, risk assessment, cash flow analysis

**Three output modes:**
- `buildBrandContext()` — Full text prompt (feeds synthesizer)
- `buildPillarContexts()` — Compact per-pillar contexts (negotiator, riskAnalyst, productCost)
- `buildBrandContextStructured()` — Typed sections for SSE events (UI visualization)

### 6.6 Offer Extractor (`offer-extractor.ts`)

- Uses Haiku 4.5 via `generateObject()` with Zod schema
- Extracts: `totalCost`, `items[]` (sku, unitPrice, quantity, optional volumeTiers), `leadTimeDays`, `paymentTerms`, `concessions[]`, `conditions[]`
- **Deterministic totalCost:** Computes from items if valid — `SUM(unitPrice × quantity)` — never trusts LLM arithmetic
- **Price range validation:** Clips offers outside supplier's allowed range, proportionally adjusts item prices
- Backfills missing items from baseline quotation
- Retry with fallback on schema validation failure

### 6.7 Decision Maker (`decision-maker.ts`)

- `analyzeCurveball()` — Analyzes disruption, proposes 2-3 strategies with supplier allocations, pros/cons. Retries up to 3 times.
- `generateFinalDecision()` — Generates final recommendation:
  - Scores all suppliers deterministically (cost, quality, leadTime, terms)
  - Evaluates split-order overhead (5% penalty) — reverts to single supplier if split isn't justified
  - Allocates SKUs to suppliers using cost-optimized allocation
  - Creates `PurchaseOrder` (draft) with allocations, items, landed cost fields (fobCost, cashFlowCost, effectiveLandedCost)
  - Returns enriched decision with reasoning, key points, trade-offs, per-SKU items with volume tiers

### 6.8 AI Cost Tracking (`lib/ai.ts`)

**CostTracker class** accumulates token usage per negotiation:

```
Pricing (per 1M tokens):
  Haiku 4.5:   $1.00 input / $5.00 output
  Sonnet 4.5:  $3.00 input / $15.00 output
```

- Global `Map<negotiationId, CostTracker>` — created on negotiation start, removed on completion
- `trackUsage()` called after every LLM invocation across all agents
- Totals persisted to `Negotiation.totalTokens` / `Negotiation.totalCostUsd` on completion
- Displayed in orchestration UI header

**Concurrency management:**
- Haiku semaphore: max 3 concurrent calls (stays under rate limits)
- Sonnet semaphore: max 2 concurrent calls
- `withSemaphore()` helper auto-acquires/releases

---

## 7. API Endpoints

All endpoints served from Express on port 4000. Next.js calls via `services/api-client.ts`.

### Auth

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/auth/login` | Authenticate with email/password, receive JWT |
| GET | `/api/auth/me` | Get current user from token |

### Parse

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/parse` | Upload XLSX, parse, match, return grouped results |
| GET | `/api/parse/:quotationId` | Load stored parse result |
| POST | `/api/parse/:quotationId/confirm` | Save HIL selections |
| PUT | `/api/parse/:quotationId/supplier` | Change quotation's supplier |
| POST | `/api/parse/:quotationId/create-supplier` | Create new supplier, assign to quotation |

### Negotiate

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/negotiate` | Start negotiation (SSE stream) |
| GET | `/api/negotiate/:negotiationId` | Load negotiation state |
| GET | `/api/negotiate/:negotiationId/stream` | SSE subscription for real-time events |
| GET | `/api/negotiate/:negotiationId/decision` | Reconstruct stored decision |
| GET | `/api/negotiate/by-quotation/:quotationId` | Find negotiation by quotation |

### Curveball

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/curveball` | Run curveball pipeline (SSE stream) |

### Purchase Orders

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/purchase-orders/:id/confirm` | Confirm draft PO → `confirmed` |

### SSE Event Types

```
negotiation_started    — Negotiation created
supplier_started       — Supplier entering negotiation (with profile data)
supplier_waiting       — Supplier waiting for competitive intel
round_start            — Round N started for supplier
context_built          — Context assembled (with structured sections)
pillar_started         — Brand Agent pillar analyzing
pillar_complete        — Brand Agent pillar done (with output preview)
message                — Agent message (brand_agent or supplier_agent)
offer_extracted        — Structured offer extracted
offers_snapshot        — All scored offers comparison
round_analysis         — Round summary with per-supplier scores
round_end              — Round complete
curveball_analysis     — Curveball impact + strategy proposals
supplier_complete      — Supplier finished all rounds
generating_decision    — Decision generation started
decision               — Final recommendation + PO created
negotiation_complete   — All rounds done
error                  — Error occurred
```

---

## 8. Frontend Pages & Components

### Main Page (`/`)

**4-step workflow: upload → review → negotiate → decision**

1. **Upload** — `FileUpload`: Drag & drop XLSX, user notes field, max rounds selector (1-5, default 4), animated progress during parsing
2. **Review** — `SupplierSection` + `ParsedDataPreview` + `QuotationTable`:
   - Supplier identification (auto-detected from XLSX metadata, user confirms/creates)
   - Parsed data overview (sheets, products, sheet metadata, estimated total)
   - HIL table: auto-accepted items (collapsed), flagged items (candidate popover), pricing tiers display
3. **Negotiate** — `NegotiationPanel`:
   - Supplier tabs with real-time SSE messages
   - Live pillar activity indicators (Negotiator, Risk Analyst, Cost Specialist)
   - Offer cards with pricing comparisons
   - Round analysis with per-supplier scores
   - Curveball alert with strategy proposals
   - Strategy insights generated from offer data
4. **Decision** — `FinalDecision` + `CashFlowInsights`:
   - Executive summary
   - Key points grid (5 dimensions: price, quality, lead time, cash flow, risk)
   - Score breakdown per supplier
   - Order preview (side-by-side per SKU with volume tiers)
   - Cash flow analysis with payment terms impact
   - Full reasoning and trade-offs (markdown rendered)

**State management:** React hooks + URL params (`quotationId`, `step`) for deep linking and session persistence.

### Orchestration Page (`/orchestration?id=...`)

**Real-time LangGraph visualization using ReactFlow.**

- **Live mode:** SSE subscription for active negotiations
- **Node types:** Supplier, Round, Pillar, Curveball, Decision
- **AI cost display:** Header shows aggregated cost when negotiation completes

### Login Page (`/login`)

Simple email/password form with JWT token storage in localStorage.

---

## 9. Negotiation Memory Architecture

**Principle: Store everything in DB, retrieve selectively for LLM.**

```
┌─────────────────────────────────────────────────────────────┐
│                     DATABASE (full history)                  │
│                                                             │
│  Every message, every offer, every round persisted          │
│  NegotiationRound + Message tables enable full replay       │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      │ Context Builder selects what LLM sees
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              LLM CONTEXT (selective retrieval)               │
│                                                             │
│  Current supplier: FULL conversation history                │
│  Other suppliers:  ONLY latest structured offer (~200 tok)  │
│  Static: baseline quotation (with rawNotes), user notes,    │
│          supplier profiles, quality metrics                  │
│                                                             │
│  Total: ~7-9K tokens per turn (well within limits)          │
└─────────────────────────────────────────────────────────────┘
```

### rawNotes Flow

Discount info, conditions, and notes extracted from XLSX by the parser flow through:
```
XLSX → llm-structurer (rawNotes field) → QuotationItem.rawNotes → toQuotationItemData() →
QuotationItemData.rawNotes → context-builder (appended to quotation table) → Brand Agent prompt
```

---

## 10. Cash Flow Scoring

Payment terms have a real financial cost. 100% upfront at $46K is more expensive than $46K at 40/60 when you account for cost of capital.

```
Cost of Capital: 8% annual (configurable in config/business-rules.ts)

Supplier 1: $42K at 33/33/33, 50 day lead
  → Cash cost: ~$229

Supplier 2: $52K at 40/60, 25 day lead
  → Cash cost: ~$114

Supplier 3: $46K at 100% upfront, 15 day lead
  → Cash cost: ~$152
```

**Scoring weights by negotiation mode** (from `config/business-rules.ts`):

| Factor     | Cost First | Quality First | Speed First | Cash Flow | Balanced |
| ---------- | :--------: | :-----------: | :---------: | :-------: | :------: |
| Raw Price  |    40%     |     15%       |    15%      |   20%     |   30%    |
| Quality    |    15%     |     40%       |    15%      |   15%     |   25%    |
| Lead Time  |    15%     |     15%       |    40%      |   15%     |   25%    |
| Terms      |    20%     |     20%       |    20%      |   40%     |   20%    |

---

## 11. Human-in-the-Loop Checkpoints

**Principle: AI proposes, human approves only at critical decision points. HIL is conditional — auto-proceed when confidence is high.**

| Checkpoint       | When it triggers                               | When it auto-proceeds               |
| ---------------- | ---------------------------------------------- | ------------------------------------ |
| Product matching | Any item < 0.85 confidence OR validation flags | All items >= 0.85 and no flags       |
| Supplier ID      | Supplier not found in DB                       | Exact match found                    |
| PO confirmation  | Always — never auto-confirm spend              | Never                                |

---

## 12. Message Formatting Standards

All agent messages use consistent SKU/product reference formatting.

### SKU Reference Format

**Standard format:** `sku(description)` with no space before the parenthesis.

**Examples:**
- ✅ `MB013-0BS-XL(Insulated Winter Jacket)`
- ✅ `MB015-RED-M(Fleece Pullover)`

### Implementation

**Centralized helpers** (`agents/format-helpers.ts`):

```typescript
formatSkuRef(sku, description)
// Returns: "MB013-0BS-XL(Insulated Winter Jacket)"

formatItemList(items, includePrice?)
// Returns formatted multi-line list:
// - MB013-0BS-XL(Insulated Winter Jacket) — Qty 50
// - MB015-RED-M(Fleece Pullover) — Qty 100
```

---

## 13. Commands

```bash
docker-compose up -d          # Start PostgreSQL (port 5433)
npm run db:migrate            # Run Prisma migrations
npm run db:seed               # Seed org + 2 suppliers + 10K products
npm run dev                   # Start API (4000) + web (3000)
npm run db:studio             # Prisma Studio
npx turbo build               # Full build check
```

---

## 14. Model Cost Summary

| Step                      | Model      | When called          | Est. Cost     |
| ------------------------- | ---------- | -------------------- | ------------- |
| Parse XLSX grid           | Haiku 4.5  | Every upload         | ~$0.005-0.01  |
| Validate extraction       | Haiku 4.5  | Every upload         | ~$0.005       |
| Match Tier 1-3            | fuse.js    | Every item           | Free          |
| Match Tier 4 LLM          | Haiku 4.5  | Only unmatched (~5%) | ~$0.01        |
| Brand Agent (3 pillars)   | Haiku 4.5  | Per round × 3        | ~$0.03-0.06   |
| Brand Agent synthesizer   | Haiku 4.5  | Per round × 3        | ~$0.01-0.02   |
| Brand Agent RFQ           | Sonnet 4.5 | Round 1 × 2          | ~$0.01        |
| Supplier Agent            | Sonnet 4.5 | Per round × 3        | ~$0.03-0.06   |
| Offer extraction          | Haiku 4.5  | Per round × 3        | ~$0.02-0.04   |
| Curveball analysis        | Sonnet 4.5 | Once                 | ~$0.01-0.02   |
| Final decision            | Sonnet 4.5 | Once                 | ~$0.01-0.02   |
| **Total per negotiation** |            |                      | **~$0.15-0.35** |

Actual cost tracked and persisted to `Negotiation.totalTokens` / `Negotiation.totalCostUsd`.
