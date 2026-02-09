# Supplier Negotiation System

> AI-powered multi-supplier negotiation platform. Upload a messy XLSX quotation, parse it into structured data, match against a 10K product catalog, then let AI agents negotiate the best deal across 3 suppliers — including handling mid-negotiation disruptions.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-lightgrey?logo=express&logoColor=white)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-6.3-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![LangGraph](https://img.shields.io/badge/LangGraph-1.1-1C3C3C?logo=langchain&logoColor=white)](https://langchain-ai.github.io/langgraphjs/)

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Project Structure](#project-structure)
- [How It Works](#how-it-works)
- [API Reference](#api-reference)
- [Environment Variables](#environment-variables)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Resilient XLSX Parsing** — Upload any supplier quotation spreadsheet. The parser handles merged cells, multiple sheets, inconsistent formatting, discount columns, and volume tiers with no hardcoded column positions.
- **5-Tier Product Matching** — Matches extracted items against a 10K product catalog: exact SKU → fuzzy SKU → fuzzy name → LLM fallback → unmatched. Only ~5% of items ever need the LLM.
- **Human-in-the-Loop Review** — Auto-accepts high-confidence matches (≥ 0.85), surfaces ambiguous items for manual review, and lets users pick from ranked candidates.
- **3-Pillar Brand Agent** — Parallel LangGraph analysis: a Negotiator (competitive tactics), Risk Analyst (supply chain assessment), and Product/Cost Specialist (SKU-level financials) run simultaneously, then a Synthesizer merges their insights into one coherent negotiation message.
- **3 Supplier Personalities** — Each AI supplier has distinct behavior: a no-nonsense price competitor, a premium quality-focused partner, and a fast/flexible solution-oriented seller — with memory of prior concessions and competitor mentions.
- **Real-Time SSE Streaming** — Every negotiation message, offer extraction, pillar analysis, and scoring event streams to the frontend in real-time via Server-Sent Events. Messages persist to the database as they generate, not batched at the end.
- **Deterministic Scoring** — Offers scored 0-100 across 5 dimensions (price, quality, lead time, cash flow, risk) with configurable mode weights. Never relies on LLM opinion for numerical scoring.
- **Curveball Handling** — Mid-negotiation disruptions (e.g., "Supplier can only fulfill 60%") trigger strategic reanalysis with 2-3 proposed recovery strategies and automatic post-curveball rounds.
- **Cash Flow Analysis** — Computes real NPV impact of payment terms (Net 60 vs. 100% upfront) using an 8% annual cost of capital rate.
- **Draft Purchase Orders** — Final decisions create PurchaseOrders with per-supplier allocations, per-SKU item breakdowns, and landed cost fields (FOB, freight, duty, cash flow cost). Always draft — humans confirm.
- **AI Cost Tracking** — Every LLM call tracked (tokens in/out, model, cost). Typical full negotiation: ~15-35 cents.
- **Multi-Tenant Ready** — Every database query scoped by `organizationId`. Demo uses a default org, but the plumbing exists for full multi-tenancy.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Turborepo Monorepo                          │
├──────────────┬──────────────┬──────────────────┬────────────────────┤
│  apps/web    │  apps/api    │ packages/database │ packages/shared    │
│  Next.js 14  │  Express     │ Prisma + PG 16   │ Types + Scoring    │
│  (port 3000) │  (port 4000) │                  │                    │
│  UI only     │  All logic   │ 12 entities      │ Shared contracts   │
└──────┬───────┴──────┬───────┴──────────┬───────┴────────────────────┘
       │              │                  │
       │   HTTP/SSE   │    Prisma ORM    │
       └──────────────┘                  │
                      └──────────────────┘
```

**Key constraint**: No API routes in Next.js. No business logic in the frontend. The web app is a pure presentation layer that communicates with the Express API via [`apps/web/src/services/api-client.ts`](apps/web/src/services/api-client.ts).

### Agent Architecture

```
┌─────────────────────── Negotiation Graph (Outer) ───────────────────────┐
│  START → initSuppliers → negotiateRound → checkConvergence ─┐          │
│                               ▲                              │          │
│                               └────── (more rounds) ────────┘          │
│                                                              → END     │
│  Per Supplier Per Round:                                               │
│    Brand Agent → Supplier Agent → Offer Extractor → Persist + SSE     │
└────────────────────────────────────────────────────────────────────────┘

┌─────────────────────── Brand Graph (Inner) ─────────────────────────────┐
│  START ──┬─► Negotiator    ──┐                                          │
│          ├─► Risk Analyst  ──┤──► Synthesizer ──► END                   │
│          └─► Product/Cost  ──┘    (merges → "Alex")                     │
│                                                                         │
│  3 pillars run in PARALLEL → single coherent message                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer                 | Technology                                                  | Purpose                                      |
| --------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| **Monorepo**          | [Turborepo](https://turbo.build/)                           | Build orchestration and caching              |
| **Frontend**          | [Next.js 14](https://nextjs.org/) (App Router)              | UI with React Server Components              |
| **Styling**           | [Tailwind CSS 3.4](https://tailwindcss.com/)                | Utility-first CSS                            |
| **Animations**        | [Framer Motion](https://www.framer.com/motion/)             | UI transitions and animations                |
| **Charts**            | [Recharts](https://recharts.org/)                           | Data visualization                           |
| **Flow Diagrams**     | [React Flow](https://reactflow.dev/)                        | Orchestration visualization                  |
| **API**               | [Express 4](https://expressjs.com/)                         | REST API + SSE streaming                     |
| **Database**          | [PostgreSQL 16](https://www.postgresql.org/) (Docker)       | Relational data storage                      |
| **ORM**               | [Prisma 6](https://www.prisma.io/)                          | Type-safe database access                    |
| **XLSX Parsing**      | [ExcelJS](https://github.com/exceljs/exceljs)               | Spreadsheet reading and cell handling        |
| **Fuzzy Matching**    | [Fuse.js](https://www.fusejs.io/)                           | SKU and product name matching                |
| **LLM Orchestration** | [Vercel AI SDK](https://sdk.vercel.ai/) (`ai`)              | Structured output via `generateObject()`     |
| **Agent Graphs**      | [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) | Stateful agent orchestration                 |
| **LLM (Parsing)**     | Claude Haiku 4.5                                            | Fast structured extraction                   |
| **LLM (Agents)**      | Claude Sonnet 4.5                                           | Multi-turn negotiation reasoning             |
| **Validation**        | [Zod](https://zod.dev/)                                     | Runtime schema validation for all LLM output |
| **Language**          | [TypeScript 5.7](https://www.typescriptlang.org/) (strict)  | End-to-end type safety                       |

---

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 10
- **Docker** (for PostgreSQL)
- **Anthropic API Key** ([console.anthropic.com](https://console.anthropic.com/))

---

## Installation

### 1. Clone and install

```bash
git clone https://github.com/your-username/supplier-negotiation.git
cd supplier-negotiation
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# Database (matches docker-compose.yml defaults)
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/postgres?schema=public"

# LLM API Key (required)
ANTHROPIC_API_KEY="sk-ant-..."
DEMO_EMAIL=
DEMO_PASSWORD=

```

### 3. Start the database

```bash
docker-compose up -d
```

### 4. Initialize the schema and seed data

```bash
npm run db:migrate    # Run Prisma migrations
npm run db:seed       # Seed 10K products + 3 suppliers + 1 org
```

### 5. Start development servers

```bash
npm run dev           # Starts API (port 4000) + Web (port 3000)
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Useful Commands

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Start API + Web in parallel                   |
| `npm run db:migrate` | Run Prisma migrations                         |
| `npm run db:seed`    | Seed products, suppliers, and org             |
| `npm run db:studio`  | Open Prisma Studio (data inspector)           |
| `npx turbo build`    | Production build (must pass with zero errors) |

---

## Usage

### End-to-End Flow

**1. Upload Quotation**

Drag and drop any supplier XLSX file. Add optional negotiation notes (e.g., "prioritize lead time") and set max negotiation rounds.

**2. Review Parsed Data**

The system extracts products from the spreadsheet — handling merged cells, discount columns, volume tiers, and inconsistent layouts. Products are matched against the catalog with confidence scores. High-confidence matches auto-accept; flagged items surface for manual review.

**3. Negotiate**

Click "Confirm & Start" to launch the AI negotiation. Three suppliers negotiate in parallel via SSE:

- **SUP-001** (from XLSX): The real baseline supplier
- **SUP-002** "Supplier2": Premium quality, higher price
- **SUP-003** "Supplier3": Fast delivery, mid-range pricing

Watch real-time messages stream in, offers get extracted, and scores update after each round. A curveball hits mid-negotiation (SUP-002 capacity constraint), and the system adapts.

**4. Decision**

After all rounds complete, the system produces:

- Executive summary with the recommended supplier
- Score breakdown across 5 dimensions
- Cash flow impact analysis
- Per-SKU allocation and pricing
- Draft purchase order (requires human confirmation)

---

## Project Structure

```
supplier-negotiation/
├── apps/
│   ├── api/                          # Express API (port 4000)
│   │   └── src/
│   │       ├── agents/               # AI agent system
│   │       │   ├── negotiation-graph.ts    # Outer graph: multi-supplier orchestration
│   │       │   ├── negotiation-loop.ts     # Entry point for negotiation execution
│   │       │   ├── brand-graph.ts          # Inner graph: 3-pillar parallel analysis
│   │       │   ├── brand-agent.ts          # Brand agent entry (RFQ + full pillar path)
│   │       │   ├── supplier-agent.ts       # 3 supplier personalities + memory
│   │       │   ├── context-builder.ts      # Selective memory assembly (token efficiency)
│   │       │   ├── offer-extractor.ts      # Structured extraction with deterministic math
│   │       │   ├── decision-maker.ts       # Curveball analysis + final recommendation
│   │       │   ├── format-helpers.ts       # SKU/product formatting standards
│   │       │   ├── types.ts                # Agent-specific types
│   │       │   ├── schemas/                # Zod schemas for decision output
│   │       │   └── utils/                  # Calculations, formatting, allocation
│   │       ├── config/
│   │       │   └── business-rules.ts       # Scoring weights by negotiation mode
│   │       ├── lib/
│   │       │   ├── ai.ts                   # All model definitions + cost tracker
│   │       │   ├── env.ts                  # Environment variable loading
│   │       │   └── event-bus.ts            # SSE event pub/sub
│   │       ├── matcher/
│   │       │   └── product-matcher.ts      # 5-tier matching (Fuse.js + LLM fallback)
│   │       ├── parser/
│   │       │   ├── xlsx-reader.ts          # ExcelJS: read, unmerge, flatten
│   │       │   ├── llm-structurer.ts       # LLM extraction with Zod validation
│   │       │   └── llm-validator.ts        # Cross-check extracted data
│   │       ├── routes/
│   │       │   ├── parse.ts                # POST /api/parse (upload + extract + match)
│   │       │   ├── negotiate.ts            # POST /api/negotiate (SSE negotiation stream)
│   │       │   ├── curveball.ts            # POST /api/curveball (disruption handling)
│   │       │   ├── purchase-orders.ts      # PO confirmation
│   │       │   └── auth.ts                 # Authentication endpoints
│   │       └── index.ts                    # Express server setup
│   │
│   └── web/                          # Next.js 14 frontend (port 3000)
│       └── src/
│           ├── app/
│           │   ├── page.tsx                # Main workflow page
│           │   ├── layout.tsx              # Root layout with auth guard
│           │   ├── orchestration/page.tsx  # Orchestration flow visualization
│           │   └── globals.css             # Tailwind base styles
│           ├── components/
│           │   ├── FileUpload.tsx           # Drag-and-drop XLSX upload
│           │   ├── ParsingLoader.tsx        # Animated parsing progress
│           │   ├── ParsedDataPreview.tsx    # Sheet metadata + pricing preview
│           │   ├── QuotationTable.tsx       # Product matching HIL review
│           │   ├── SupplierSection.tsx      # Supplier identification
│           │   ├── NegotiationPanel.tsx     # Real-time negotiation UI
│           │   ├── CurveballAlert.tsx       # Curveball strategy picker
│           │   ├── FinalDecision.tsx        # Decision dashboard
│           │   ├── CashFlowInsights.tsx     # Cash flow analysis charts
│           │   ├── OrchestrationFlow.tsx    # React Flow agent visualization
│           │   ├── WorkflowSidebar.tsx      # Step-based workflow navigation
│           │   └── AuthGuard.tsx            # Authentication wrapper
│           ├── services/
│           │   └── api-client.ts           # Sole bridge between frontend and API
│           └── lib/
│               └── formatting.ts           # Client-side formatting utilities
│
├── packages/
│   ├── database/                     # Prisma schema + migrations + seed
│   │   └── prisma/
│   │       ├── schema.prisma               # 12 entity models (source of truth)
│   │       └── seed.ts                     # 10K products + 3 suppliers + 1 org
│   └── shared/                       # Shared TypeScript types + scoring
│       └── src/
│           ├── types.ts                    # Shared type contracts
│           ├── scoring.ts                  # Deterministic offer scoring
│           └── suppliers.ts                # Supplier constants
│
├── docker-compose.yml                # PostgreSQL 16
├── turbo.json                        # Turborepo task config
├── CLAUDE.md                         # Architectural constitution
└── .env.example                      # Environment template
```

---

## How It Works

### XLSX Parsing Pipeline

```
XLSX File
  → ExcelJS (read, unmerge cells, flatten to string grid)
  → Preprocessing (strip empty rows/cols)
  → LLM Structurer (Haiku + Zod schema → items + metadata)
    - Large sheets: chunked with header repetition
    - Post-extraction: discount sanity check
  → LLM Validator (cross-check arithmetic)
  → Product Matcher (5-tier: exact → fuzzy SKU → fuzzy name → LLM → unmatched)
  → Human Review (confidence < 0.85)
```

### Negotiation Engine

Each round follows this sequence for every active supplier:

1. **Context Builder** assembles targeted context (full history for current supplier, latest offer only for others — ~70% token savings)
2. **Brand Graph** (inner LangGraph) runs 3 specialist pillars in parallel:
   - **Negotiator**: competitive tactics, leverage points, FOMO
   - **Risk Analyst**: supply chain risks, price discrepancies
   - **Product/Cost**: SKU-level analysis, cash flow impact
3. **Synthesizer** merges all 3 briefs into one message as "Alex" (80-100 words max)
4. **Supplier Agent** responds with counter-offer (personality-driven, memory-aware, price-constrained)
5. **Offer Extractor** parses response into structured data (Zod-validated, deterministic totalCost)
6. **Scoring** updates 5-dimension scores across all suppliers
7. **Persist + Stream** writes to DB and emits SSE event simultaneously

### Scoring Model

Offers are scored 0-100 on 5 dimensions with mode-based weights:

| Mode          | Price | Quality | Lead Time | Cash Flow | Risk |
| ------------- | ----- | ------- | --------- | --------- | ---- |
| Balanced      | 25%   | 20%     | 20%       | 15%       | 20%  |
| Cost First    | 35%   | 15%     | 15%       | 20%       | 15%  |
| Quality First | 15%   | 35%     | 15%       | 15%       | 20%  |
| Speed First   | 15%   | 15%     | 35%       | 15%       | 20%  |
| Cash Flow     | 20%   | 15%     | 15%       | 35%       | 15%  |

---

## API Reference

| Method | Endpoint                           | Description                                     |
| ------ | ---------------------------------- | ----------------------------------------------- |
| `POST` | `/api/auth/login`                  | Authenticate and receive JWT                    |
| `GET`  | `/api/auth/me`                     | Get current user                                |
| `POST` | `/api/parse`                       | Upload XLSX, parse, match (multipart/form-data) |
| `GET`  | `/api/parse/:quotationId`          | Load stored parse result                        |
| `POST` | `/api/parse/:quotationId/confirm`  | Confirm product match selections                |
| `POST` | `/api/negotiate`                   | Start negotiation (returns SSE stream)          |
| `GET`  | `/api/negotiate/:id`               | Load negotiation state from DB                  |
| `GET`  | `/api/negotiate/:id/stream`        | Subscribe to live SSE events                    |
| `GET`  | `/api/negotiate/:id/decision`      | Load stored decision                            |
| `GET`  | `/api/negotiate/by-quotation/:id`  | Find negotiation by quotation                   |
| `POST` | `/api/curveball`                   | Trigger curveball disruption (SSE)              |
| `POST` | `/api/purchase-orders/:id/confirm` | Confirm draft PO                                |
| `GET`  | `/api/health`                      | Health check                                    |

---

## Environment Variables

| Variable              | Required | Description                                                      |
| --------------------- | -------- | ---------------------------------------------------------------- |
| `DATABASE_URL`        | Yes      | PostgreSQL connection string                                     |
| `ANTHROPIC_API_KEY`   | Yes      | Anthropic API key for Claude models                              |
| `PORT`                | No       | API server port (default: 4000)                                  |
| `NEXT_PUBLIC_API_URL` | No       | API base URL for frontend (default: `http://localhost:4000/api`) |

---

## Database Schema

12 entities with full relational integrity:

- **Organization** — Multi-tenant root
- **Supplier** — 3 suppliers with quality ratings, lead times, payment terms
- **Product** — 10K product catalog with SKU, name, brand, color, size
- **Quotation** → **QuotationItem** — Parsed XLSX data with match results
- **Negotiation** → **NegotiationRound** → **Message** — Full conversation history
- **PurchaseOrder** → **PurchaseOrderAllocation** → **PurchaseOrderItem** — Draft orders with landed cost fields

Every query is scoped by `organizationId` for multi-tenant isolation.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Run the build to verify (`npx turbo build`)
5. Commit with a descriptive message
6. Push and open a Pull Request

### Code Style

- TypeScript strict mode across all packages
- Async/await only (no `.then` chains)
- Every LLM call wrapped in try/catch with descriptive context
- Zod validation before any LLM output touches the database

---

## License

This project is proprietary. All rights reserved.
