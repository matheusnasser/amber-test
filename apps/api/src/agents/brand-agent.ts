/**
 * BRAND AGENT - Valden Outdoor's AI Procurement Specialist
 *
 * Role: Acts as "Alex" from Valden Outdoor, negotiating with 3 suppliers to get best deal
 *
 * Architecture: 3-Pillar System (parallel analysis via LangGraph)
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  NEGOTIATOR         RISK ANALYST        PRODUCT/COST        │
 *   │  - Competitive      - Supply chain      - SKU analysis      │
 *   │    bidding          - Backup plans      - Cash flow         │
 *   │  - Leverage         - Diversify         - Volume pricing    │
 *   │  - FOMO tactics     - Risk mitigation   - Landed cost       │
 *   └───────────────────────┬─────────────────────────────────────┘
 *                           │
 *                      SYNTHESIZER
 *                (Merges → Single Message)
 *
 * Fast Path: Round 1 with SUP-002/SUP-003 → Simple RFQ (no pillar analysis)
 * Full Path: All other rounds → 3 pillars analyze in parallel → synthesized message
 *
 * Context: Sees FULL history with current supplier, ONLY latest offers from others
 * Models: Claude Haiku (pillars + synthesizer) - fast parallel analysis
 */

import { sonnetSemaphore, trackUsage, withSemaphore } from "../lib/ai";
import type { PillarEvent } from "./brand-graph";
import { brandGraph, setOnPillarEvent } from "./brand-graph";
import type { ContextSections } from "./context-builder";
import { buildBrandContext, buildBrandContextStructured, buildPillarContexts } from "./context-builder";
import { formatItemList } from "./format-helpers";
import type {
  MessageData,
  OfferData,
  QuotationItemData,
  SupplierProfile,
} from "./types";

// ─── Brand Message via LangGraph (3-Pillar Architecture) ────────────────────

interface CreateBrandMessageParams {
  currentSupplierId: string;
  negotiationId: string;
  quotationItems: QuotationItemData[];
  userNotes: string;
  supplierProfiles: SupplierProfile[];
  allOffers: Map<string, OfferData>;
  conversationHistory: MessageData[];
  roundNumber: number;
  totalRounds: number;
  isXlsxSource?: boolean;
  isQuoteRequest?: boolean;
  isReQuote?: boolean;
  qtyChanges?: Record<string, { from: number; to: number }>;
  priorOffer?: OfferData;
  onPillarEvent?: (event: PillarEvent) => void;
  onContextBuilt?: (summary: string, sections: ContextSections) => void;
}

export async function createBrandMessage(
  params: CreateBrandMessageParams,
): Promise<string> {
  const startTime = Date.now();
  const supplierProfile = params.supplierProfiles.find(
    (p) => p.id === params.currentSupplierId,
  );
  const supplierName = supplierProfile?.name ?? "the supplier";

  console.log(
    `brand-agent: Generating message via BrandGraph for ${supplierName} (round ${params.roundNumber}, ${params.conversationHistory.length} prior messages${params.isQuoteRequest ? ", QUOTE REQUEST" : ""})...`,
  );

  // ── Fast path: Quote Request (S2/S3 round 1) ──
  // No pillar analysis needed — just a clean RFQ with SKUs and quantities.
  if (params.isQuoteRequest) {
    const { agentModel: rfqModel } = await import("../lib/ai");
    const { HumanMessage, SystemMessage } = await import("@langchain/core/messages");

    const itemList = formatItemList(params.quotationItems);

    const rfqPrompt = `<role>
You are Alex, a senior procurement specialist at Valden Outdoor. You are reaching out to ${supplierName} to request a quotation for specific items.
</role>

<items_to_quote>
${itemList}
</items_to_quote>

<instructions>
Write a brief, professional quote request message (under 150 words):
1. Introduce yourself as Alex from Valden Outdoor's procurement team.
2. Explain you're sourcing outdoor apparel/equipment and evaluating suppliers.
3. List the items you need quoted — use the PRODUCT DESCRIPTION (not the internal ref code) and quantity. Do NOT mention any prices.
4. Ask for their best per-unit pricing, lead time, and payment terms.
5. Mention you need the quote promptly as you're making a decision soon.

The ref codes (like MB013-0BS-XL) are OUR internal references — the supplier won't know them. Always lead with the product description so they can identify what we need.

Be warm and professional. This is a new business inquiry — make them want to compete for the order.
</instructions>`;

    const response = await withSemaphore(sonnetSemaphore, () =>
      rfqModel.invoke([
        new SystemMessage(rfqPrompt),
        new HumanMessage("Write the quote request message now."),
      ]),
    );

    trackUsage(params.negotiationId, "claude-sonnet-4-5-20250929", response);

    const text = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const elapsed = Date.now() - startTime;
    console.log(`brand-agent: Quote request generated in ${elapsed}ms (${text.length} chars)`);
    return text;
  }

  // ── Re-Quote: enrich userNotes with qty change context so pillars can reason about it ──
  if (params.isReQuote && params.qtyChanges && Object.keys(params.qtyChanges).length > 0) {
    const changedLines: string[] = [];
    for (const item of params.quotationItems) {
      const change = params.qtyChanges[item.rawSku];
      if (change) {
        const priorItem = params.priorOffer?.items.find(
          (i) => i.sku.toUpperCase() === item.rawSku.toUpperCase(),
        );
        const priorUnitPrice = priorItem?.unitPrice ?? item.unitPrice;
        changedLines.push(
          `- ${item.rawDescription}: Qty ${change.from} → ${change.to} (was $${priorUnitPrice.toFixed(2)}/unit)`,
        );
      }
    }
    if (changedLines.length > 0) {
      const reQuoteContext = `\n\nRE-QUOTE: The buyer has updated order quantities. Focus on these specific SKU changes:\n${changedLines.join("\n")}\nAll other items remain at previously agreed quantities and pricing. Negotiate the price impact of ONLY the changed items. Reference the prior deal terms where relevant.`;
      params = { ...params, userNotes: params.userNotes + reQuoteContext };
    }
  }

  // Build the full context prompt (feeds synthesizer node)
  const contextBuilderParams = {
    currentSupplierId: params.currentSupplierId,
    negotiationId: params.negotiationId,
    quotationItems: params.quotationItems,
    userNotes: params.userNotes,
    supplierProfiles: params.supplierProfiles,
    allOffers: params.allOffers,
    conversationHistory: params.conversationHistory,
    roundNumber: params.roundNumber,
    totalRounds: params.totalRounds,
  };
  const contextPrompt = await buildBrandContext(contextBuilderParams);

  // Build compact pillar-specific contexts (reduces tokens per pillar by ~70%)
  const pillarContexts = buildPillarContexts(contextBuilderParams);

  // Emit structured context sections + short summary
  if (params.onContextBuilt) {
    const sections = buildBrandContextStructured({
      currentSupplierId: params.currentSupplierId,
      negotiationId: params.negotiationId,
      quotationItems: params.quotationItems,
      userNotes: params.userNotes,
      supplierProfiles: params.supplierProfiles,
      allOffers: params.allOffers,
      conversationHistory: params.conversationHistory,
      roundNumber: params.roundNumber,
      totalRounds: params.totalRounds,
    });

    const otherOffers = Array.from(params.allOffers.entries())
      .filter(([id]) => id !== params.currentSupplierId)
      .map(([, offer]) => `$${offer.totalCost.toLocaleString()} / ${offer.leadTimeDays}d`)
      .join(", ");
    const contextSummary = [
      `Supplier: ${supplierName}`,
      `Items: ${params.quotationItems.length} SKUs`,
      `Round: ${params.roundNumber}/${params.totalRounds}`,
      otherOffers ? `Competing offers: ${otherOffers}` : "No competing offers yet",
      params.userNotes ? `Priorities: ${params.userNotes.slice(0, 100)}` : null,
    ].filter(Boolean).join(" | ");
    params.onContextBuilt(contextSummary, sections);
  }

  // Set pillar event callback for this invocation
  if (params.onPillarEvent) {
    setOnPillarEvent(params.onPillarEvent);
  }

  try {
    const result = await brandGraph.invoke({
      negotiationId: params.negotiationId,
      currentSupplierId: params.currentSupplierId,
      supplierName,
      quotationItems: params.quotationItems,
      supplierProfiles: params.supplierProfiles,
      allOffers: params.allOffers,
      conversationHistory: params.conversationHistory,
      roundNumber: params.roundNumber,
      totalRounds: params.totalRounds,
      userNotes: params.userNotes,
      contextPrompt,
      pillarContexts: pillarContexts as never,
      isXlsxSource: (params.isXlsxSource ?? false) as never,
      pillarOutputs: {},
      finalMessage: "",
    });

    const text = result.finalMessage;

    const elapsed = Date.now() - startTime;
    console.log(
      `brand-agent: BrandGraph complete in ${elapsed}ms (${text.length} chars, ${Object.keys(result.pillarOutputs).length} pillars)`,
    );

    return text;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`brand-agent: BrandGraph failed after ${elapsed}ms: ${message}`);
    throw new Error(`Brand agent failed to generate message: ${message}`);
  } finally {
    // Clear callback to avoid leaks
    setOnPillarEvent(null);
  }
}
