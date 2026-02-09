/**
 * NEGOTIATION LOOP - Top-Level Orchestrator
 *
 * Entry point for negotiation execution. Called by API routes.
 *
 * Main Functions:
 *
 * 1. runNegotiation(quotationId, mode, userNotes, emitEvent)
 *    - Loads quotation items + 3 suppliers (SUP-001 from XLSX, SUP-002/003 simulated)
 *    - Deduplicates items by SKU (keeps smallest qty as primary, attaches pricing tiers)
 *    - Creates Negotiation record in DB (status: "negotiating")
 *    - Invokes negotiationGraph (LangGraph) which orchestrates all rounds
 *    - Streams SSE events to frontend in real-time via emitEvent callback
 *    - Persists events to NegotiationEvent table for timeline replay
 *    - Tracks AI cost (tokens + USD) via CostTracker
 *    - Updates Negotiation record with final cost totals on completion
 *
 * 2. runPostCurveballRounds(negotiationId, selectedStrategy, emitEvent)
 *    - Rebuilds existing negotiation state (offers, conversations)
 *    - Enriches user notes with chosen curveball strategy
 *    - Runs graph again with phase: "post_curveball"
 *    - Preserves all previous conversation history
 *    - Continues round numbering from where curveball interrupted
 *
 * SSE Event Flow:
 *   negotiation_started → supplier_started (×3) →
 *   [per round] round_start → context_built → pillar_started → pillar_complete (×3) →
 *             → message (brand_agent) → message (supplier_agent) → offer_extracted →
 *             → offers_snapshot → round_end →
 *   [if curveball] curveball_detected →
 *   supplier_complete (×3) → negotiation_complete
 *
 * Models Used: All agent models (Haiku, Sonnet) - tracks usage across all calls
 *
 * ── KEY POINTS ──────────────────────────────────────────────────
 *   • Single entry point kicks off the entire multi-supplier negotiation
 *   • SSE streaming — every pillar, message, and offer appears live, no polling
 *   • Deduplicates quotation tiers — one SKU = one negotiation line
 *   • Built-in AI cost tracking — tokens and USD logged per LLM call
 * ────────────────────────────────────────────────────────────────
 */

import { prisma } from "@supplier-negotiation/database";
import { negotiationGraph } from "./negotiation-graph";
import { getCostTracker, removeCostTracker } from "../lib/ai";
import type { ScoredOffer } from "@supplier-negotiation/shared";
import type { ContextSections } from "./context-builder";
import type { CurveballAnalysis } from "./decision-maker";
import type {
  SupplierProfile,
  QuotationItemData,
  OfferData,
  MessageData,
} from "./types";

// ─── SSE Event Types ─────────────────────────────────────────────────────────

export type SSEEvent =
  | { type: "negotiation_started"; negotiationId: string; timestamp: number }
  | { type: "supplier_started"; supplierId: string; supplierName: string; supplierCode: string; quality: number; priceLevel: string; leadTime: number; terms: string; isSimulated: boolean; timestamp: number }
  | { type: "round_start"; supplierId: string; roundNumber: number; timestamp: number }
  | { type: "supplier_waiting"; supplierId: string; supplierName: string; supplierCode: string; reason: string; roundNumber: number; timestamp: number }
  | {
      type: "context_built";
      supplierId: string;
      roundNumber: number;
      summary: string;
      sections: ContextSections;
      timestamp: number;
    }
  | {
      type: "pillar_started";
      pillar: string;
      supplierId: string;
      roundNumber: number;
      timestamp: number;
    }
  | {
      type: "pillar_complete";
      pillar: string;
      supplierId: string;
      roundNumber: number;
      output?: string;
      timestamp: number;
    }
  | {
      type: "message";
      role: "brand_agent" | "supplier_agent";
      supplierId: string;
      supplierName: string;
      content: string;
      roundNumber: number;
      phase: "initial" | "post_curveball";
      messageId: string;
      timestamp: number;
    }
  | {
      type: "offer_extracted";
      supplierId: string;
      roundNumber: number;
      offer: OfferData;
      timestamp: number;
    }
  | { type: "offers_snapshot"; offers: ScoredOffer[]; timestamp: number }
  | { type: "round_analysis"; roundNumber: number; summary: string; supplierScores: { supplierName: string; supplierId: string; totalCost: number; leadTimeDays: number; paymentTerms: string; weightedScore: number; concessions: string[] }[]; timestamp: number }
  | { type: "round_end"; supplierId: string; roundNumber: number; timestamp: number }
  | { type: "curveball_detected"; supplierId: string; roundNumber: number; description: string; timestamp: number }
  | { type: "curveball_analysis"; analysis: CurveballAnalysis; timestamp: number }
  | { type: "supplier_complete"; supplierId: string; timestamp: number }
  | { type: "negotiation_complete"; negotiationId: string; timestamp: number }
  | { type: "decision"; recommendation: unknown; comparison: unknown; summary: string; keyPoints: unknown[]; reasoning: string; tradeoffs: string; purchaseOrderId: string; allSupplierAllocations: unknown; timestamp: number }
  | { type: "error"; message: string; timestamp: number };

// ─── Params ──────────────────────────────────────────────────────────────────

interface RunNegotiationParams {
  negotiationId: string;
  quotationId: string;
  userNotes: string;
  mode: string;
  maxRounds?: number;
  supplierIds?: string[]; // if set, only negotiate with these suppliers
  priorOffers?: Record<string, OfferData>; // seed from previous negotiation (re-quote)
  isReQuote?: boolean;
  qtyChanges?: Record<string, { from: number; to: number }>;
  onEvent: (event: SSEEvent) => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toSupplierProfile(supplier: {
  id: string;
  name: string;
  code: string;
  qualityRating: number;
  priceLevel: string;
  leadTimeDays: number;
  paymentTerms: string;
  isSimulated: boolean;
}): SupplierProfile {
  return {
    id: supplier.id,
    name: supplier.name,
    code: supplier.code,
    qualityRating: supplier.qualityRating,
    priceLevel: supplier.priceLevel,
    leadTimeDays: supplier.leadTimeDays,
    paymentTerms: supplier.paymentTerms,
    isSimulated: supplier.isSimulated,
  };
}

function toQuotationItemData(item: {
  rawSku: string;
  rawDescription: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  rawNotes?: string | null;
}): QuotationItemData {
  return {
    rawSku: item.rawSku,
    rawDescription: item.rawDescription,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    totalPrice: item.totalPrice,
    rawNotes: item.rawNotes,
  };
}

/**
 * Deduplicate quotation items that share the same SKU (pricingTiers).
 * For negotiation, keep one entry per SKU — the tier with the smallest quantity
 * (the realistic order size), and attach ALL tiers for context.
 */
function deduplicateItems(items: QuotationItemData[]): QuotationItemData[] {
  const byKey = new Map<string, QuotationItemData[]>();
  for (const item of items) {
    const key = item.rawSku.toUpperCase().trim();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(item);
  }
  const deduped: QuotationItemData[] = [];
  for (const [, group] of byKey) {
    // Sort by quantity ascending — use the smallest tier as the "active" one
    group.sort((a, b) => a.quantity - b.quantity);
    const primary = group[0];
    // Attach all tiers if multiple exist
    if (group.length > 1) {
      primary.tiers = group.map((g) => ({
        quantity: g.quantity,
        unitPrice: g.unitPrice,
        totalPrice: g.totalPrice,
      }));
    }
    deduped.push(primary);
  }
  if (deduped.length < items.length) {
    console.log(
      `negotiation-loop: Deduplicated ${items.length} items → ${deduped.length} unique SKUs (pricing tiers merged)`,
    );
  }
  return deduped;
}

// ─── Main Loop (LangGraph NegotiationGraph) ─────────────────────────────────

export async function runNegotiation(
  params: RunNegotiationParams,
): Promise<void> {
  const { negotiationId, quotationId, userNotes, onEvent } = params;
  const effectiveMaxRounds = params.maxRounds ?? 3;

  const startTime = Date.now();
  console.log(
    `\n=== NEGOTIATION STARTED (LangGraph): ${negotiationId} ===`,
  );

  // 1. Load quotation items from DB
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id: quotationId },
    include: {
      items: true,
      organization: true,
      supplier: true,
    },
  });

  const rawItems = quotation.items.map(toQuotationItemData);
  const quotationItems = deduplicateItems(rawItems);

  // 1b. Extract sheet metadata from rawData (payment terms, lead time, etc.)
  let metadataNotes = "";
  try {
    const rawData = quotation.rawData as { sheetMetadata?: Record<string, Record<string, unknown>> } | null;
    if (rawData?.sheetMetadata) {
      const metaParts: string[] = [];
      for (const [sheetName, meta] of Object.entries(rawData.sheetMetadata)) {
        const parts: string[] = [];
        if (meta.paymentTerms) parts.push(`Payment terms: ${meta.paymentTerms}`);
        if (meta.leadTimeDays) parts.push(`Lead time: ${meta.leadTimeDays} days`);
        if (meta.incoterm) parts.push(`Incoterm: ${meta.incoterm}`);
        if (meta.currency) parts.push(`Currency: ${meta.currency}`);
        if (meta.moq) parts.push(`MOQ: ${meta.moq}`);
        if (meta.validUntil) parts.push(`Valid until: ${meta.validUntil}`);
        if (meta.notes) parts.push(`Notes: ${meta.notes}`);
        if (parts.length > 0) {
          metaParts.push(`[${sheetName}] ${parts.join(" | ")}`);
        }
      }
      if (metaParts.length > 0) {
        metadataNotes = `\n\nQUOTATION METADATA (from XLSX):\n${metaParts.join("\n")}`;
        console.log(`negotiation-loop: Injecting sheet metadata: ${metaParts.join("; ")}`);
      }
    }
  } catch {
    // Ignore metadata parsing errors — non-critical
  }

  // 2. Load the negotiation suppliers
  const quotationSupplierCode = quotation.supplier?.code ?? "SUP-001";
  const quotationSupplierId = quotation.supplier?.id;

  let suppliers;
  if (params.supplierIds && params.supplierIds.length > 0) {
    // Re-quote: only selected suppliers
    suppliers = await prisma.supplier.findMany({
      where: { id: { in: params.supplierIds } },
      orderBy: { code: "asc" },
    });
    console.log(`negotiation-loop: Re-quote mode — ${suppliers.length} selected suppliers`);
  } else {
    // Normal: quotation source + simulated competitors
    // If the quotation supplier is a custom-created one, include it by ID
    const SIMULATED_CODES = ["SUP-002", "SUP-003"];
    const negotiationCodes = [...new Set([quotationSupplierCode, ...SIMULATED_CODES])];
    
    suppliers = await prisma.supplier.findMany({
      where: {
        organizationId: quotation.organizationId,
        OR: [
          { code: { in: negotiationCodes } },
          ...(quotationSupplierId ? [{ id: quotationSupplierId }] : []),
        ],
      },
      orderBy: { code: "asc" },
    });
  }

  if (suppliers.length === 0) {
    throw new Error("No negotiation suppliers found. Run db:seed first.");
  }

  // Ensure XLSX source supplier comes first
  suppliers.sort((a, b) => {
    if (a.code === quotationSupplierCode) return -1;
    if (b.code === quotationSupplierCode) return 1;
    return a.code.localeCompare(b.code);
  });

  const supplierProfiles = suppliers.map(toSupplierProfile);

  console.log(
    `negotiation-loop: ${quotationItems.length} unique items (from ${rawItems.length} rows), ${suppliers.length} suppliers, up to ${effectiveMaxRounds} rounds each (LangGraph orchestration)`,
  );

  // 3. Invoke the LangGraph NegotiationGraph
  // If re-quoting, seed with prior offers so agents have competitive context from round 1
  const seedOffers = params.priorOffers ?? {};
  if (Object.keys(seedOffers).length > 0) {
    console.log(`negotiation-loop: Seeding ${Object.keys(seedOffers).length} prior offers into graph state`);
  }

  await negotiationGraph.invoke({
    negotiationId,
    quotationItems,
    supplierProfiles,
    userNotes: (userNotes ?? "") + metadataNotes,
    phase: "initial" as const,
    maxRounds: effectiveMaxRounds,
    mode: (params.mode ?? "balanced") as never,
    quotationSupplierCode: quotationSupplierCode as never,
    isReQuote: (params.isReQuote ?? false) as never,
    qtyChanges: (params.qtyChanges ?? {}) as never,
    onEvent,
    allOffers: seedOffers,
    conversationHistories: {},
    previousOffers: {},
    currentRound: 0,
    isComplete: false,
  });

  // 4. Update negotiation status
  // Persist AI cost tracking
  const costTotals = getCostTracker(negotiationId).totals;
  removeCostTracker(negotiationId);

  await prisma.negotiation.update({
    where: { id: negotiationId },
    data: {
      status: "completed",
      totalTokens: costTotals.totalTokens,
      totalCostUsd: costTotals.totalCostUsd,
    },
  });

  const totalElapsed = Date.now() - startTime;
  console.log(
    `\n=== NEGOTIATION COMPLETE in ${totalElapsed}ms | AI Cost: $${costTotals.totalCostUsd} (${costTotals.totalTokens} tokens) ===\n`,
  );

  onEvent({ type: "negotiation_complete", negotiationId, timestamp: Date.now() });
}

// ─── Post-Curveball Rounds (Concurrent) ─────────────────────────────────────

interface PostCurveballParams {
  negotiationId: string;
  curveballDescription: string;
  affectedSupplierId: string;
  curveballAnalysis?: CurveballAnalysis;
  maxRounds?: number;
  onEvent: (event: SSEEvent) => void;
}

export async function runPostCurveballRounds(
  params: PostCurveballParams,
): Promise<void> {
  const { negotiationId, curveballDescription, affectedSupplierId, curveballAnalysis, onEvent } =
    params;

  const startTime = Date.now();
  console.log(
    `\n=== POST-CURVEBALL ROUNDS (LangGraph): ${negotiationId} ===`,
  );

  // Load negotiation with quotation
  const negotiation = await prisma.negotiation.findUniqueOrThrow({
    where: { id: negotiationId },
    include: {
      quotation: { include: { items: true, organization: true, supplier: true } },
    },
  });

  const quotationItems = deduplicateItems(negotiation.quotation.items.map(toQuotationItemData));

  // Load the negotiation suppliers: quotation source + simulated competitors
  const postCurveballSupplierCode = negotiation.quotation.supplier?.code ?? "SUP-001";
  const postCurveballCodes = [...new Set([postCurveballSupplierCode, "SUP-002", "SUP-003"])];
  const suppliers = await prisma.supplier.findMany({
    where: { organizationId: negotiation.quotation.organizationId, code: { in: postCurveballCodes } },
    orderBy: { code: "asc" },
  });

  // Ensure XLSX source supplier comes first
  suppliers.sort((a, b) => {
    if (a.code === postCurveballSupplierCode) return -1;
    if (b.code === postCurveballSupplierCode) return 1;
    return a.code.localeCompare(b.code);
  });

  const supplierProfiles = suppliers.map(toSupplierProfile);

  // Rebuild existing offers and conversation histories
  const initialOffers: Record<string, OfferData> = {};
  const conversationHistories: Record<string, MessageData[]> = {};
  const previousOffers: Record<string, OfferData> = {};

  for (const supplier of suppliers) {
    // Load latest initial offer
    const latestRound = await prisma.negotiationRound.findFirst({
      where: {
        negotiationId,
        supplierId: supplier.id,
        phase: "initial",
      },
      orderBy: { roundNumber: "desc" },
    });
    if (latestRound?.offerData) {
      initialOffers[supplier.id] = latestRound.offerData as unknown as OfferData;
      previousOffers[supplier.id] = latestRound.offerData as unknown as OfferData;
    }

    // Rebuild conversation history
    const existingRounds = await prisma.negotiationRound.findMany({
      where: { negotiationId, supplierId: supplier.id },
      orderBy: { roundNumber: "asc" },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    conversationHistories[supplier.id] = existingRounds.flatMap((r) =>
      r.messages.map((m) => ({
        role: m.role as "brand_agent" | "supplier_agent",
        content: m.content,
      })),
    );
  }

  // Build curveball-enriched user notes with full strategy context
  const curveballNotesParts: string[] = [
    `=== CURVEBALL DISRUPTION ===`,
    `${curveballDescription}`,
  ];

  if (curveballAnalysis) {
    curveballNotesParts.push(`\nIMPACT: ${curveballAnalysis.impact}`);
    curveballNotesParts.push(`\nRECOMMENDED STRATEGY: ${curveballAnalysis.recommendation}`);
    if (curveballAnalysis.strategies.length > 0) {
      curveballNotesParts.push(`\nAVAILABLE STRATEGIES:`);
      for (const strategy of curveballAnalysis.strategies) {
        const allocations = strategy.suppliers.map((s) => `${s.supplierName}: ${s.allocationPct}%`).join(", ");
        curveballNotesParts.push(`  - ${strategy.name}: ${strategy.description} [${allocations}] Est. cost: $${strategy.estimatedCost.toLocaleString()}`);
      }
    }
  }

  curveballNotesParts.push(`\nPER-SUPPLIER DIRECTIVES:`);
  for (const s of suppliers) {
    const isAffected = s.id === affectedSupplierId;
    curveballNotesParts.push(
      isAffected
        ? `  - ${s.name} (${s.code}): AFFECTED — capacity reduced to 60%. Push for better per-unit pricing on reduced volume. Their quality (${s.qualityRating}/5) may justify keeping them at reduced allocation.`
        : `  - ${s.name} (${s.code}): OPPORTUNITY — can absorb up to 40% additional volume. Negotiate competitive pricing for increased allocation. Lead time: ${s.leadTimeDays}d, terms: ${s.paymentTerms}.`,
    );
  }

  const userNotes = [negotiation.userNotes, curveballNotesParts.join("\n")].filter(Boolean).join("\n\n");

  // Post-curveball uses remaining round budget from caller, or falls back to DB setting
  const remainingRounds = params.maxRounds ?? negotiation.maxRounds ?? 3;
  console.log(
    `post-curveball: ${remainingRounds} rounds (budget from caller: ${params.maxRounds ?? "none"}, DB: ${negotiation.maxRounds ?? 3})`,
  );

  // Find the affected supplier's code for curveball injection
  const affectedSupplier = suppliers.find((s) => s.id === affectedSupplierId);
  const curveballSupplierCode = affectedSupplier?.code ?? null;

  // Invoke the NegotiationGraph for post-curveball
  await negotiationGraph.invoke({
    negotiationId,
    quotationItems,
    supplierProfiles,
    userNotes,
    phase: "post_curveball" as const,
    maxRounds: remainingRounds,
    mode: (negotiation.mode ?? "balanced") as never,
    quotationSupplierCode: postCurveballSupplierCode as never,
    curveballSupplierCode: curveballSupplierCode as never,
    onEvent,
    allOffers: initialOffers,
    conversationHistories,
    previousOffers,
    currentRound: 0,
    isComplete: false,
  });

  const totalElapsed = Date.now() - startTime;
  console.log(
    `\n=== POST-CURVEBALL ROUNDS COMPLETE in ${totalElapsed}ms ===\n`,
  );
}
