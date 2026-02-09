/**
 * DECISION MAKER - Curveball Analysis & Final Recommendation
 *
 * Two main functions:
 *
 * 1. CURVEBALL ANALYSIS (analyzeCurveball)
 *    Triggered: Round 2, when SUP-002 announces 60% capacity constraint
 *    Input: Current offers from all 3 suppliers
 *    Output: CurveballAnalysis with 2-3 strategic options:
 *      - Impact assessment (what does 60% constraint mean?)
 *      - Strategy proposals (e.g., "Go all-in on S1", "Split 60% S2 + 40% S1")
 *      - Per-strategy: supplier allocations, estimated cost, pros/cons
 *    Used by: Frontend to show strategy picker + backend to enrich user notes for post-curveball rounds
 *
 * 2. FINAL DECISION (generateFinalDecision)
 *    Triggered: After all negotiation rounds complete
 *    Input: All final offers + supplier profiles + quotation items
 *    Output: FinalRecommendation with:
 *      - Deterministic scoring (0-100) across 4 dimensions:
 *        • Cost (raw price + cash flow impact)
 *        • Quality (supplier rating + defect rate)
 *        • Lead Time (delivery speed)
 *        • Payment Terms (cash flow friendly?)
 *      - Recommended supplier(s) with allocation percentages
 *      - Executive summary + reasoning
 *      - Key trade-offs explained
 *      - Creates draft PurchaseOrder with:
 *        • PurchaseOrderAllocations (per supplier)
 *        • PurchaseOrderItems (per product)
 *        • Landed cost fields (FOB, freight, duty, cash flow cost)
 *
 * Scoring Weights (by negotiation mode):
 *   Cost First:     40% cost, 15% quality, 15% lead, 20% terms
 *   Quality First:  15% cost, 40% quality, 15% lead, 20% terms
 *   Speed First:    15% cost, 15% quality, 40% lead, 20% terms
 *   Cash Flow:      20% cost, 15% quality, 15% lead, 40% terms
 *   Balanced:       30% cost, 25% quality, 25% lead, 20% terms
 *
 * Model: Claude Sonnet 4.5 via Vercel AI SDK generateObject() (complex reasoning + Zod validation)
 *
 * ── KEY POINTS ──────────────────────────────────────────────────
 *   • Handles curveball disruptions — generates 2-3 alternative strategies in real-time
 *   • Multi-dimensional scoring: cost, quality, lead time, payment terms
 *   • User's priority mode shifts scoring weights (cost-first, quality-first, etc.)
 *   • Creates draft Purchase Order with per-SKU allocations and landed cost fields
 *   • Automation prepares; humans approve — POs always start as "draft"
 * ────────────────────────────────────────────────────────────────
 */

import { prisma } from "@supplier-negotiation/database";
import { generateObject } from "ai";
import { getScoringWeights } from "../config/business-rules";
import { getCostTracker, reasoningModel } from "../lib/ai";
import {
  curveballAnalysisSchema,
  finalDecisionSchema,
  type CurveballAnalysisOutput,
  type FinalDecisionOutput,
} from "./schemas/decision-schemas";
import type { OfferData } from "./types";
import { calculateCashFlowCost, evaluateSplitOverhead } from "./utils/calculations";
import {
  formatSupplierOffer,
  loadLatestOffers,
} from "./utils/decision-helpers";
import {
  allocateSkusToSuppliers,
  type QuotationItemForAllocation
} from "./utils/sku-allocation";

// Import and re-export shared types
import type {
  AllocationItem,
  CurveballAnalysis,
  CurveballStrategy,
  FinalDecisionData,
  FinalRecommendation,
  KeyPoint,
  SupplierAllocation,
  SupplierScore,
} from "@supplier-negotiation/shared";

export type {
  AllocationItem, CurveballAnalysis, CurveballStrategy, FinalDecisionData, FinalRecommendation,
  KeyPoint, SupplierAllocation, SupplierScore
};

// Local type alias for consistency
export type FinalDecision = FinalDecisionData;

// ─── Module Organization ────────────────────────────────────────────────────
// SKU allocation logic → utils/sku-allocation.ts
// Zod schemas → schemas/decision-schemas.ts
// Helper functions → utils/decision-helpers.ts
// Business rules → config/business-rules.ts

// ─── SKU Allocation (now imported from utils/sku-allocation.ts) ────────────

// allocateSkusToSuppliers and reallocateSkusAfterCurveball moved to utils/sku-allocation.ts


// ─── Schemas and Helpers (now imported from separate modules) ──────────────

// curveballAnalysisSchema, finalDecisionSchema → schemas/decision-schemas.ts
// formatSupplierOffer, loadLatestOffers → utils/decision-helpers.ts

// ─── Analyze Curveball ──────────────────────────────────────────────────────

export async function analyzeCurveball(
  negotiationId: string,
  affectedSupplierId: string,
  curveballDescription: string,
): Promise<CurveballAnalysis> {
  const startTime = Date.now();
  console.log(`decision-maker: Analyzing curveball for ${negotiationId}...`);

  const negotiation = await prisma.negotiation.findUniqueOrThrow({
    where: { id: negotiationId },
  });

  const offerMap = await loadLatestOffers(negotiationId, "initial");

  const supplierSummaries: string[] = [];
  for (const [supplierId, { offer, profile }] of offerMap) {
    supplierSummaries.push(
      formatSupplierOffer(offer, profile, supplierId === affectedSupplierId),
    );
  }

  const prompt = `<role>You are a senior procurement analyst specializing in supply chain disruption response.</role>

<curveball_event>
${curveballDescription}
</curveball_event>

<current_supplier_offers>
${supplierSummaries.join("\n\n")}
</current_supplier_offers>

${negotiation.userNotes ? `<user_priorities>\n${negotiation.userNotes}\n</user_priorities>` : ""}

<instructions>
Analyze the impact of this curveball and propose 2-3 actionable strategies. For each strategy, provide specific supplier allocations with percentages and estimated costs.

Consider:
- Splitting the order between multiple suppliers (e.g., 60% from affected supplier + 40% from another)
- Dropping the affected supplier entirely and redistributing
- Renegotiating with the affected supplier for reduced volume at better per-unit pricing
- Quality differences between suppliers (quality ratings matter for outdoor apparel)
- Lead time implications of splitting orders
- Cash flow impact of different payment term combinations

Use the exact supplier IDs provided in the offers above. Each strategy must include concrete supplier allocations that sum to 100%.
</instructions>`;

  let object: CurveballAnalysisOutput;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await generateObject({
        model: reasoningModel,
        schema: curveballAnalysisSchema,
        prompt:
          attempt === 1
            ? prompt
            : `${prompt}\n\nIMPORTANT: Your previous response was incomplete. You MUST include ALL fields: impact, strategies (array of 2-3 objects with name, description, suppliers, estimatedCost, pros, cons), and recommendation.`,
      });
      object = result.object;

      // Track cost
      if (result.usage) {
        getCostTracker(negotiationId).track(
          "claude-sonnet-4-5-20250929",
          result.usage.promptTokens,
          result.usage.completionTokens,
        );
      }

      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      console.warn(
        `decision-maker: Curveball attempt ${attempt}/3 failed: ${(err as Error).message?.slice(0, 200)}`,
      );
      if (attempt === 3) throw lastError;
    }
  }
  object = object!;

  await prisma.negotiation.update({
    where: { id: negotiationId },
    data: {
      curveballDesc: curveballDescription,
      curveballData: JSON.parse(JSON.stringify(object)),
      status: "curveball",
    },
  });

  const elapsed = Date.now() - startTime;
  console.log(
    `decision-maker: Curveball analysis complete in ${elapsed}ms — ${object.strategies.length} strategies`,
  );

  return object;
}

// ─── Generate Final Decision ────────────────────────────────────────────────

export async function generateFinalDecision(
  negotiationId: string,
): Promise<FinalDecision> {
  const startTime = Date.now();
  console.log(
    `decision-maker: Generating final decision for ${negotiationId}...`,
  );

  const negotiation = await prisma.negotiation.findUniqueOrThrow({
    where: { id: negotiationId },
    include: {
      quotation: { include: { items: true } },
    },
  });

  // Load offers: prefer post-curveball, fall back to initial
  const initialOffers = await loadLatestOffers(negotiationId, "initial");
  const postCurveballOffers = await loadLatestOffers(
    negotiationId,
    "post_curveball",
  );

  const finalOffers = new Map(initialOffers);
  for (const [supplierId, data] of postCurveballOffers) {
    finalOffers.set(supplierId, data);
  }

  const weights = getScoringWeights(negotiation.mode);

  // Build baseline items for per-item comparison (deduplicated — smallest qty tier per SKU)
  const baselineItemsBySku = new Map<string, { rawSku: string; rawDescription: string; quantity: number; unitPrice: number; totalPrice: number }>();
  for (const i of negotiation.quotation.items) {
    const key = i.rawSku.toUpperCase().trim();
    const existing = baselineItemsBySku.get(key);
    if (!existing || i.quantity < existing.quantity) {
      baselineItemsBySku.set(key, {
        rawSku: i.rawSku,
        rawDescription: i.rawDescription,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        totalPrice: i.quantity * i.unitPrice,
      });
    }
  }
  const baselineItems = Array.from(baselineItemsBySku.values());
  const totalBaselineUnits = baselineItems.reduce((s, i) => s + i.quantity, 0);
  const baselineTotal = baselineItems.reduce((s, i) => s + i.totalPrice, 0);

  const supplierSummaries: string[] = [];
  for (const [, { offer, profile }] of finalOffers) {
    supplierSummaries.push(
      formatSupplierOffer(offer, profile, false, baselineItems),
    );
  }

  // Detect re-quote by checking if prior context was injected into userNotes
  const isReQuote =
    (negotiation.userNotes?.includes("RE-QUOTE CONTEXT") ||
      negotiation.userNotes?.includes("PRIOR NEGOTIATION CONTEXT")) ??
    false;

  const prompt = `<role>You are a senior procurement analyst. ${isReQuote ? "This is a RE-QUOTE — the buyer adjusted quantities from a prior deal. Focus on how the changes affect pricing, lead time, and cash flow compared to the prior offer." : "Select the best supplier(s) based on weighted tradeoffs — NOT just the cheapest price."}</role>

${negotiation.userNotes ? `<user_priorities>\n${negotiation.userNotes}\nThese priorities HEAVILY influence scoring.\n</user_priorities>` : ""}

${negotiation.curveballDesc ? `<curveball>\n${negotiation.curveballDesc}\n</curveball>` : ""}

<scoring_model>
Mode: ${negotiation.mode}
Weights: Cost ${(weights.cost * 100).toFixed(0)}%, Quality ${(weights.quality * 100).toFixed(0)}%, Lead Time ${(weights.leadTime * 100).toFixed(0)}%, Terms ${(weights.terms * 100).toFixed(0)}%
Formula: totalScore = costScore×${weights.cost} + qualityScore×${weights.quality} + leadTimeScore×${weights.leadTime} + termsScore×${weights.terms}
</scoring_model>

<baseline_reference>
Baseline (XLSX source) total: $${baselineTotal.toLocaleString()} across ${baselineItems.length} items (${totalBaselineUnits.toLocaleString()} total units).
All supplier offers should be compared on the SAME unit quantities. If a supplier's total is dramatically different (e.g., 5-10x), this is a data integrity issue — score their cost based on normalized per-unit pricing × baseline quantities.
</baseline_reference>

<supplier_offers>
${supplierSummaries.join("\n\n")}
</supplier_offers>

<instructions>
Evaluate all suppliers and produce a final decision. You MUST include ALL of these fields:

1. **recommendation** (MOST IMPORTANT — never omit): primarySupplierId, primarySupplierName, splitOrder, and allocations array. Allocations must sum to 100%. Use exact supplier IDs from above. agreedCost should be proportional to allocationPct.

2. **comparison**: Score each supplier 0-100 on costScore, qualityScore, leadTimeScore, termsScore, and compute totalScore using the weights above. IMPORTANT: Score costScore on a NORMALIZED per-unit basis — a supplier quoting different quantities should not get a worse score simply because their total is higher. Normalize to the same baseline quantities.

3. **summary**: 2-3 sentence executive summary focused on WHY this is the best choice given the user's priorities — not just the cheapest.${isReQuote ? " IMPORTANT: The summary MUST explicitly state what changed in this re-quote (e.g., 'After adjusting quantities for X SKUs, the total cost shifted from $Y to $Z'). Highlight whether the re-quote resulted in savings, cost increases, or better terms compared to the prior deal." : ""}

4. **keyPoints**: One key insight per dimension (price, quality, leadTime, cashFlow, risk) with the winning supplier.

5. **reasoning**: Comprehensive justification using markdown formatting. Structure as follows:
   ## Price Analysis
   Compare per-unit pricing across suppliers with specific SKU examples. Show baseline vs offered unit prices. Include total cost normalized to same quantities.
   ## Quality Assessment
   Rate each supplier's quality rating and how it translates to value. Reference defect rates and reliability.
   ## Lead Time & Logistics
   Compare delivery timelines. Quantify the business impact of faster/slower delivery.
   ## Cash Flow Impact
   Analyze payment terms impact on working capital. Compare effective landed costs.${
     isReQuote
       ? `
   ## Re-Quote Impact
   Summarize how the quantity changes affected the deal: which SKUs changed, how pricing shifted per-unit and total, and whether lead time or payment terms were renegotiated. Compare the new deal to the prior negotiation outcome.`
       : ""
   }
   ## Risk Assessment
   Concentration risk, supplier reliability concerns, and recommended mitigation.
   ## Quantity Verification
   Confirm all offers were evaluated on the same ${totalBaselineUnits.toLocaleString()} total units across ${baselineItems.length} items. Flag any discrepancies.
   Use specific dollar amounts, percentages, and SKU references throughout. Max 800 words.

6. **tradeoffs**: Key tradeoffs formatted with markdown bullet points. For each tradeoff: what was gained, what was sacrificed, and why it's acceptable. Max 300 words.
</instructions>`;

  // Retry up to 3 times — the schema is large and the LLM occasionally omits fields
  let object: FinalDecisionOutput;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await generateObject({
        model: reasoningModel,
        schema: finalDecisionSchema,
        prompt:
          attempt === 1
            ? prompt
            : `${prompt}\n\nIMPORTANT: Your previous response was incomplete. You MUST include ALL top-level fields: recommendation (with primarySupplierId, primarySupplierName, splitOrder, allocations), comparison, summary, keyPoints, reasoning, and tradeoffs.`,
      });
      object = result.object;

      // Track cost
      if (result.usage) {
        getCostTracker(negotiationId).track(
          "claude-sonnet-4-5-20250929",
          result.usage.promptTokens,
          result.usage.completionTokens,
        );
      }

      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      console.warn(
        `decision-maker: Attempt ${attempt}/3 failed: ${(err as Error).message?.slice(0, 200)}`,
      );
      if (attempt === 3) throw lastError;
    }
  }
  // TypeScript: object is guaranteed assigned if we didn't throw
  object = object!;

  // ─── Apply split overhead penalty ───────────────────────────────────────────
  if (
    object.recommendation.splitOrder &&
    object.recommendation.allocations.length > 1
  ) {
    const singleSupplierOption = object.comparison.reduce((best, curr) =>
      curr.totalScore > best.totalScore ? curr : best,
    );

    const splitEval = evaluateSplitOverhead(
      singleSupplierOption.totalScore,
      object.recommendation.allocations.map((a) => ({
        supplier: a.supplierName,
        score:
          object.comparison.find((c) => c.supplierId === a.supplierId)
            ?.totalScore ?? 0,
        pct: a.allocationPct,
      })),
    );

    if (!splitEval.worthIt) {
      console.log(
        `decision-maker: Split overhead not justified (single: ${singleSupplierOption.totalScore} vs split adjusted: ${splitEval.adjustedScores.reduce((sum, s) => sum + (s.score * s.pct) / 100, 0).toFixed(1)}). Recommending single supplier.`,
      );
      object.recommendation.splitOrder = false;
      object.recommendation.primarySupplierId = singleSupplierOption.supplierId;
      object.recommendation.primarySupplierName =
        singleSupplierOption.supplierName;
      object.recommendation.allocations = [
        {
          supplierId: singleSupplierOption.supplierId,
          supplierName: singleSupplierOption.supplierName,
          allocationPct: 100,
          agreedCost:
            finalOffers.get(singleSupplierOption.supplierId)?.offer.totalCost ??
            0,
          leadTimeDays:
            finalOffers.get(singleSupplierOption.supplierId)?.offer
              .leadTimeDays ?? 0,
          paymentTerms:
            finalOffers.get(singleSupplierOption.supplierId)?.offer
              .paymentTerms ?? "",
        },
      ];
    }
  }

  // Create PurchaseOrder with allocations and items (idempotent — skip if already exists)
  // Deduplicate items by SKU — keep smallest-qty tier (matches negotiation baseline)
  const allMatchedItems = negotiation.quotation.items.filter(
    (i) => i.productId != null,
  );
  const matchedItemsBySku = new Map<string, typeof allMatchedItems[0]>();
  for (const item of allMatchedItems) {
    const key = item.rawSku.toUpperCase().trim();
    const existing = matchedItemsBySku.get(key);
    if (!existing || item.quantity < existing.quantity) {
      matchedItemsBySku.set(key, item);
    }
  }
  const matchedItems = Array.from(matchedItemsBySku.values());

  let existingPO = await prisma.purchaseOrder.findUnique({
    where: { negotiationId },
  });

  if (existingPO) {
    // PO already exists (e.g. from a previous decision call) — update it
    existingPO = await prisma.purchaseOrder.update({
      where: { id: existingPO.id },
      data: {
        totalCost: object.recommendation.allocations.reduce(
          (sum, a) => sum + a.agreedCost,
          0,
        ),
        reasoning: object.reasoning,
        comparisonData: JSON.parse(
          JSON.stringify({
            comparison: object.comparison,
            summary: object.summary,
            keyPoints: object.keyPoints,
            tradeoffs: object.tradeoffs,
            reasoning: object.reasoning,
          }),
        ),
      },
    });
  }

  // ─── Allocate SKUs to suppliers ─────────────────────────────────────────────
  const skuAllocations = allocateSkusToSuppliers(
    matchedItems.map((item) => ({
      rawSku: item.rawSku,
      rawDescription: item.rawDescription,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.quantity * item.unitPrice,
      productId: item.productId,
    })),
    new Map(
      Array.from(finalOffers.entries()).map(([id, data]) => [id, data.offer]),
    ),
    object.recommendation.allocations.map((a) => ({
      supplierId: a.supplierId,
      targetPct: a.allocationPct,
    })),
  );

  const purchaseOrder =
    existingPO ??
    (await prisma.purchaseOrder.create({
      data: {
        organizationId: negotiation.organizationId,
        negotiationId,
        status: "draft",
        totalCost: object.recommendation.allocations.reduce(
          (sum, a) => sum + a.agreedCost,
          0,
        ),
        reasoning: object.reasoning,
        comparisonData: JSON.parse(
          JSON.stringify({
            comparison: object.comparison,
            summary: object.summary,
            keyPoints: object.keyPoints,
            tradeoffs: object.tradeoffs,
            reasoning: object.reasoning,
          }),
        ),
        allocations: {
          create: object.recommendation.allocations.map((alloc) => {
            const supplierData = finalOffers.get(alloc.supplierId);
            const assignedItems = skuAllocations.get(alloc.supplierId) ?? [];

            // Recalculate actual cost based on assigned SKUs
            const actualCost = assignedItems.reduce((sum, item) => {
              const offerItem = supplierData?.offer.items.find(
                (oi) => oi.sku.toUpperCase() === item.rawSku.toUpperCase(),
              );
              return (
                sum +
                (offerItem
                  ? offerItem.unitPrice * item.quantity
                  : item.totalPrice)
              );
            }, 0);

            const cashFlowCost = calculateCashFlowCost(
              actualCost,
              alloc.paymentTerms,
              alloc.leadTimeDays,
            );

            return {
              supplierId: alloc.supplierId,
              allocationPct: alloc.allocationPct,
              agreedCost: actualCost,
              agreedLeadTimeDays: alloc.leadTimeDays,
              agreedPaymentTerms: alloc.paymentTerms,
              fobCost: actualCost,
              cashFlowCost,
              effectiveLandedCost: actualCost + cashFlowCost,
              items: {
                create: assignedItems
                  .filter((item) => item.productId != null)
                  .map((item) => {
                    const offerItem = supplierData?.offer.items.find(
                      (oi) =>
                        oi.sku.toUpperCase() === item.rawSku.toUpperCase(),
                    );
                    const unitPrice = offerItem?.unitPrice ?? item.unitPrice;

                    return {
                      productId: item.productId!,
                      quantity: item.quantity,
                      agreedUnitPrice: unitPrice,
                      agreedTotalPrice: item.quantity * unitPrice,
                    };
                  }),
              },
            };
          }),
        },
      },
    }));

  await prisma.negotiation.update({
    where: { id: negotiationId },
    data: { status: "completed" },
  });

  const elapsed = Date.now() - startTime;
  console.log(
    `decision-maker: Final decision complete in ${elapsed}ms — PO ${purchaseOrder.id}`,
  );

  // Helper to build allocation items with volume tier passthrough
  const buildAllocItems = (
    offer: OfferData,
    assignedSkus: QuotationItemForAllocation[],
  ): AllocationItem[] =>
    assignedSkus.map((qi) => {
      const offerItem = offer.items.find(
        (oi) => oi.sku.toUpperCase() === qi.rawSku.toUpperCase(),
      );
      const unitPrice = offerItem?.unitPrice ?? qi.unitPrice;
      return {
        sku: qi.rawSku,
        description: qi.rawDescription,
        quantity: qi.quantity,
        unitPrice,
        totalPrice: qi.quantity * unitPrice,
        ...(offerItem?.volumeTiers && offerItem.volumeTiers.length > 0
          ? { volumeTiers: offerItem.volumeTiers }
          : {}),
      };
    });

  // Enrich allocations with per-SKU items for the frontend preview
  const enrichedAllocations: SupplierAllocation[] =
    object.recommendation.allocations.map((alloc) => {
      const supplierData = finalOffers.get(alloc.supplierId);
      const assignedSkus = skuAllocations.get(alloc.supplierId) ?? [];
      const items = supplierData
        ? buildAllocItems(supplierData.offer, assignedSkus)
        : [];
      return { ...alloc, items };
    });

  // Build enriched allocations for ALL suppliers (including non-selected) for side-by-side preview
  const selectedIds = new Set(
    object.recommendation.allocations.map((a) => a.supplierId),
  );
  const allSupplierAllocations: SupplierAllocation[] = [...enrichedAllocations];

  for (const [supplierId, { offer, profile }] of finalOffers) {
    if (selectedIds.has(supplierId)) continue;
    const allItems = matchedItems.map((item) => ({
      rawSku: item.rawSku,
      rawDescription: item.rawDescription,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.quantity * item.unitPrice,
      productId: item.productId,
    }));
    allSupplierAllocations.push({
      supplierId,
      supplierName: profile.name,
      allocationPct: 0,
      agreedCost: offer.totalCost,
      leadTimeDays: offer.leadTimeDays,
      paymentTerms: offer.paymentTerms,
      items: buildAllocItems(offer, allItems),
    });
  }

  return {
    recommendation: {
      ...object.recommendation,
      allocations: enrichedAllocations,
    },
    comparison: object.comparison,
    summary: object.summary,
    keyPoints: object.keyPoints,
    reasoning: object.reasoning,
    tradeoffs: object.tradeoffs,
    purchaseOrderId: purchaseOrder.id,
    allSupplierAllocations,
  };
}
