/**
 * CONTEXT BUILDER - Selective Memory Assembly for Agent Turns
 *
 * Problem: Can't send full conversation history to LLM every turn (token explosion)
 * Solution: Build targeted context based on what each agent/pillar needs
 *
 * Strategy:
 *   - Current Supplier: FULL conversation history (all messages)
 *   - Other Suppliers: ONLY latest structured offer (~200 tokens each)
 *   - Static Data: Always included
 *     • Baseline quotation (with SKU formatting, pricing tiers, rawNotes)
 *     • User notes / priorities
 *     • Supplier profiles (quality, lead time, terms, performance metrics)
 *     • Quality comparison across suppliers
 *     • Cash flow analysis (payment terms impact)
 *
 * Functions:
 *   1. buildBrandContext() → Full text prompt for synthesizer
 *   2. buildPillarContexts() → Compact per-pillar contexts (70% smaller)
 *   3. buildBrandContextStructured() → Typed sections for SSE visualization
 *   4. formatQuotationTable() → Baseline quotation with tiers
 *   5. buildCashFlowAnalysis() → Payment terms cost analysis
 *
 * Result: ~7-9K tokens per turn instead of 20-30K (massive savings)
 *
 * ── KEY POINTS ──────────────────────────────────────────────────
 *   • Current supplier: full conversation. Competitors: 200-token offer summaries
 *   • Drops token usage from ~25K to ~8K per turn — 70% reduction
 *   • Each pillar gets a different context slice — tailored, not one-size-fits-all
 *   • Includes cash flow analysis, quality comparison, risk flags per supplier
 * ────────────────────────────────────────────────────────────────
 */

import { formatSkuRef } from "./format-helpers";
import type {
    MessageData,
    OfferData,
    QuotationItemData,
    SupplierProfile,
} from "./types";
import { calculateCashFlowCost } from "./utils/calculations";
import { summarizeAndTrimHistory } from "./utils/conversation-history";
import {
    formatCurrency,
    formatQuotationTable,
    formatSupplierProfile
} from "./utils/formatting";

// ─── Structured Context Sections (for SSE event) ────────────────────────────

export interface ContextSections {
  quotationItems: {
    sku: string;
    description: string;
    qty: number;
    unitPrice: number;
    totalPrice: number;
  }[];
  supplierProfile: {
    name: string;
    code: string;
    quality: number;
    priceLevel: string;
    leadTime: number;
    terms: string;
  } | null;
  competitiveIntel: {
    label: string;
    totalCost: number;
    leadTime: number;
    terms: string;
    concessions: string[];
  }[];
  cashFlowSummary: string;
  riskFlags: string[];
  roundStrategy: string;
  userPriorities: string;
}

interface BuildBrandContextParams {
  currentSupplierId: string;
  negotiationId: string;
  quotationItems: QuotationItemData[];
  userNotes: string;
  supplierProfiles: SupplierProfile[];
  allOffers: Map<string, OfferData>; // supplierId → latest offer
  conversationHistory: MessageData[]; // current supplier only
  roundNumber: number;
  totalRounds: number;
}

// ─── Local Helpers ──────────────────────────────────────────────────────────

// Anonymization helper (not in utils yet, keeping local for now)
function anonymizeSupplierName(
  supplierId: string,
  currentSupplierId: string,
  supplierProfiles: SupplierProfile[],
): string {
  const others = supplierProfiles
    .filter((p) => p.id !== currentSupplierId)
    .sort((a, b) => a.code.localeCompare(b.code));
  const idx = others.findIndex((p) => p.id === supplierId);
  return (
    ["Supplier A", "Supplier B", "Supplier C"][idx] ?? `Supplier ${idx + 1}`
  );
}

// ─── Cash Flow Analysis (Pillar 3: Product Knowledge) ───────────────────────

function buildCashFlowAnalysis(params: BuildBrandContextParams): string {
  const { currentSupplierId, supplierProfiles, allOffers, quotationItems } =
    params;
  const baselineTotal = quotationItems.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );
  const currentSupplier = supplierProfiles.find(
    (p) => p.id === currentSupplierId,
  );

  const lines: string[] = [];

  // Current supplier's baseline cash flow cost
  if (currentSupplier) {
    const baselineCF = calculateCashFlowCost(
      baselineTotal,
      currentSupplier.paymentTerms,
      currentSupplier.leadTimeDays,
    );
    lines.push(
      `${currentSupplier.name} baseline: ${formatCurrency(baselineTotal)} FOB + ${formatCurrency(baselineCF)} cash flow cost = ${formatCurrency(baselineTotal + baselineCF)} effective landed cost (${currentSupplier.paymentTerms} terms, ${currentSupplier.leadTimeDays}d lead)`,
    );
  }

  // Current supplier's latest offer cash flow cost (if they've made one)
  const currentOffer = allOffers.get(currentSupplierId);
  if (currentOffer && currentSupplier) {
    const offerCF = calculateCashFlowCost(
      currentOffer.totalCost,
      currentOffer.paymentTerms,
      currentOffer.leadTimeDays,
    );
    lines.push(
      `${currentSupplier.name} current offer: ${formatCurrency(currentOffer.totalCost)} FOB + ${formatCurrency(offerCF)} cash flow cost = ${formatCurrency(currentOffer.totalCost + offerCF)} effective landed cost (${currentOffer.paymentTerms} terms, ${currentOffer.leadTimeDays}d lead)`,
    );
  }

  // Other suppliers' offers for comparison
  for (const [id, offer] of allOffers.entries()) {
    if (id === currentSupplierId) continue;
    const profile = supplierProfiles.find((p) => p.id === id);
    if (!profile) continue;
    const anonLabel = anonymizeSupplierName(
      id,
      currentSupplierId,
      supplierProfiles,
    );
    const cf = calculateCashFlowCost(
      offer.totalCost,
      offer.paymentTerms,
      offer.leadTimeDays,
    );
    lines.push(
      `${anonLabel}: ${formatCurrency(offer.totalCost)} FOB + ${formatCurrency(cf)} cash flow cost = ${formatCurrency(offer.totalCost + cf)} effective landed cost (${offer.paymentTerms} terms, ${offer.leadTimeDays}d lead)`,
    );
  }

  if (lines.length === 0) return "";
  return lines.join("\n");
}

// ─── Competitive Intelligence ───────────────────────────────────────────────

function buildCompetitiveIntelligence(params: BuildBrandContextParams): string {
  const { allOffers, currentSupplierId, supplierProfiles, quotationItems } =
    params;

  const otherOffers = Array.from(allOffers.entries())
    .filter(([id]) => id !== currentSupplierId)
    .map(([id, offer]) => {
      const profile = supplierProfiles.find((p) => p.id === id);
      return { id, profile, offer };
    })
    .filter((o) => o.profile);

  if (otherOffers.length === 0) return "";

  const baselineTotal = quotationItems.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );
  const currentSupplier = supplierProfiles.find(
    (p) => p.id === currentSupplierId,
  );

  const lowestCost = Math.min(...otherOffers.map((o) => o.offer.totalCost));
  const lowestCostEntry = otherOffers.find(
    (o) => o.offer.totalCost === lowestCost,
  );
  const fastestLead = Math.min(...otherOffers.map((o) => o.offer.leadTimeDays));
  const fastestEntry = otherOffers.find(
    (o) => o.offer.leadTimeDays === fastestLead,
  );

  const lines: string[] = [];

  // Price leader
  if (lowestCostEntry?.profile) {
    const savingsPct = (
      ((baselineTotal - lowestCost) / baselineTotal) *
      100
    ).toFixed(1);
    const anonPriceLeader = anonymizeSupplierName(
      lowestCostEntry.id,
      currentSupplierId,
      supplierProfiles,
    );
    lines.push(
      `Price leader: ${anonPriceLeader} at ${formatCurrency(lowestCost)} (${savingsPct}% below baseline), ${lowestCostEntry.offer.leadTimeDays}d lead, ${lowestCostEntry.offer.paymentTerms} terms${lowestCostEntry.offer.concessions.length > 0 ? `, concessions: ${lowestCostEntry.offer.concessions.join(", ")}` : ""}`,
    );
  }

  // Speed leader
  if (fastestEntry?.profile && fastestEntry.id !== lowestCostEntry?.id) {
    const anonSpeedLeader = anonymizeSupplierName(
      fastestEntry.id,
      currentSupplierId,
      supplierProfiles,
    );
    lines.push(
      `Speed leader: ${anonSpeedLeader} at ${fastestEntry.offer.leadTimeDays}d lead, ${formatCurrency(fastestEntry.offer.totalCost)}`,
    );
  }

  // Leverage angles
  const leverageAngles: string[] = [];

  if (currentSupplier?.priceLevel === "expensive" && lowestCostEntry?.profile) {
    const anonPriceLeader = anonymizeSupplierName(
      lowestCostEntry.id,
      currentSupplierId,
      supplierProfiles,
    );
    leverageAngles.push(
      `${currentSupplier.name} is premium-positioned but ${anonPriceLeader} is at ${formatCurrency(lowestCost)}. Frame it as partnership: "We value your quality record, but the ${formatCurrency(baselineTotal - lowestCost)} gap is significant for our budget."`,
    );
  }

  if (
    currentSupplier &&
    currentSupplier.leadTimeDays > fastestLead &&
    fastestEntry?.profile
  ) {
    const anonSpeedLeader = anonymizeSupplierName(
      fastestEntry.id,
      currentSupplierId,
      supplierProfiles,
    );
    leverageAngles.push(
      `${currentSupplier.name}'s ${currentSupplier.leadTimeDays}d lead is slower than ${anonSpeedLeader}'s ${fastestLead}d. Use this to negotiate faster delivery or a price offset.`,
    );
  }

  if (currentSupplier?.priceLevel === "cheapest" && fastestEntry?.profile) {
    const anonSpeedLeader = anonymizeSupplierName(
      fastestEntry.id,
      currentSupplierId,
      supplierProfiles,
    );
    leverageAngles.push(
      `${currentSupplier.name} competes on price but lead time is ${currentSupplier.leadTimeDays}d. ${anonSpeedLeader}'s speed may offset the cost difference — use this to push for faster delivery.`,
    );
  }

  if (leverageAngles.length > 0) {
    lines.push(`Leverage: ${leverageAngles.join(" ")}`);
  }

  // All offers summary
  for (const entry of otherOffers) {
    if (!entry.profile) continue;
    const anonLabel = anonymizeSupplierName(
      entry.id,
      currentSupplierId,
      supplierProfiles,
    );
    const costVsBaseline = (
      (entry.offer.totalCost / baselineTotal - 1) *
      100
    ).toFixed(1);
    lines.push(
      `${anonLabel}: ${formatCurrency(entry.offer.totalCost)} (${costVsBaseline}% vs baseline), ${entry.offer.leadTimeDays}d lead, ${entry.offer.paymentTerms} terms`,
    );
  }

  return lines.join("\n");
}

// ─── Quality Comparison ─────────────────────────────────────────────────────

function buildQualityComparison(
  currentSupplier: SupplierProfile,
  supplierProfiles: SupplierProfile[],
  currentSupplierId: string,
): string {
  const others = supplierProfiles.filter((p) => p.id !== currentSupplierId);
  const bestQuality = Math.max(...supplierProfiles.map((p) => p.qualityRating));
  const worstQuality = Math.min(
    ...supplierProfiles.map((p) => p.qualityRating),
  );

  const lines = [`${currentSupplier.name}: ${currentSupplier.qualityRating}/5`];
  for (const other of others) {
    const anonLabel = anonymizeSupplierName(
      other.id,
      currentSupplierId,
      supplierProfiles,
    );
    lines.push(`${anonLabel}: ${other.qualityRating}/5`);
  }

  if (currentSupplier.qualityRating < bestQuality) {
    const better = supplierProfiles.find(
      (p) => p.qualityRating === bestQuality,
    );
    const anonBetter = better
      ? anonymizeSupplierName(better.id, currentSupplierId, supplierProfiles)
      : "another supplier";
    lines.push(
      `${anonBetter} has the highest quality at ${bestQuality}/5. Use this to pressure ${currentSupplier.name} on quality or demand lower pricing.`,
    );
  }
  if (
    currentSupplier.qualityRating === bestQuality &&
    bestQuality > worstQuality
  ) {
    lines.push(
      `${currentSupplier.name} has the best quality rating. They may justify premium pricing — push back noting other suppliers meet acceptable thresholds at lower cost.`,
    );
  }

  return lines.join("\n");
}

// ─── Risk Assessment ────────────────────────────────────────────────────────

function buildRiskAssessment(
  currentSupplier: SupplierProfile,
  supplierProfiles: SupplierProfile[],
  currentSupplierId: string,
): string {
  const lines: string[] = [];

  // Lead time risk
  const fastestLead = Math.min(...supplierProfiles.map((p) => p.leadTimeDays));
  if (currentSupplier.leadTimeDays > fastestLead * 2) {
    lines.push(
      `Lead time risk: ${currentSupplier.leadTimeDays}d lead is ${(currentSupplier.leadTimeDays / fastestLead).toFixed(1)}x the fastest option. Longer lead times increase exposure to demand forecast changes and inventory carrying costs.`,
    );
  }

  // Payment terms risk
  const upfrontPct =
    parseInt(currentSupplier.paymentTerms.split("/")[0], 10) || 0;
  if (upfrontPct >= 100) {
    lines.push(
      `Payment risk: ${currentSupplier.name} requires 100% upfront payment. This maximizes buyer cash flow exposure with zero leverage if quality issues arise post-delivery.`,
    );
  }

  // Quality rating comparison
  const bestQuality = Math.max(...supplierProfiles.map((p) => p.qualityRating));
  if (currentSupplier.qualityRating < bestQuality) {
    const gap = bestQuality - currentSupplier.qualityRating;
    lines.push(
      `Quality gap: ${currentSupplier.name}'s quality rating (${currentSupplier.qualityRating}/5) is ${gap.toFixed(1)} points below the best supplier. Lower quality increases rework and return costs.`,
    );
  }

  if (lines.length === 0) {
    lines.push(
      `${currentSupplier.name} has acceptable risk metrics: ${currentSupplier.qualityRating}/5 quality, ${currentSupplier.leadTimeDays}d lead time, ${currentSupplier.paymentTerms} terms. Push for delivery guarantees at the negotiated price.`,
    );
  }

  return lines.join("\n");
}

// ─── Round Strategy ─────────────────────────────────────────────────────────

function buildRoundStrategy(
  roundNumber: number,
  totalRounds: number,
  hasCompetitiveData: boolean,
  conversationLength: number,
): string {
  if (conversationLength === 0) {
    return "Opening message. Introduce yourself as Alex from Valden Outdoor. You're evaluating 3 suppliers — set the competitive tone and probe on price, lead time, and terms.";
  }
  if (roundNumber >= totalRounds) {
    return "Final round. Present the best competing numbers and demand they beat or match to win. Create urgency — you're deciding now.";
  }
  if (hasCompetitiveData) {
    return "Use competing offers as leverage. Cite specific competing numbers (never names). Frame it as a live auction — push hard on price, then lead time, then terms.";
  }
  return "Probe on price, lead time, and terms. Build competitive pressure — you're waiting on other quotes and want their best offer early.";
}

// ─── Main Builder ───────────────────────────────────────────────────────────

export async function buildBrandContext(
  params: BuildBrandContextParams,
): Promise<string> {
  const {
    currentSupplierId,
    quotationItems,
    userNotes,
    supplierProfiles,
    allOffers,
    conversationHistory,
    roundNumber,
    totalRounds,
  } = params;

  const currentSupplier = supplierProfiles.find(
    (p) => p.id === currentSupplierId,
  );

  const hasOtherOffers = Array.from(allOffers.keys()).some(
    (id) => id !== currentSupplierId,
  );

  const supplierName = currentSupplier?.name ?? "the supplier";

  // ── Assemble prompt: long-form data at top, instructions at bottom ──

  const sections: string[] = [];

  // ━━━ DATA SECTIONS (top) — feed the 5 pillars ━━━

  sections.push(`<baseline_quotation>
Items and prices submitted by ${supplierName} in their original quote:
${formatQuotationTable(quotationItems)}
</baseline_quotation>`);

  if (currentSupplier) {
    sections.push(`<current_supplier>
${formatSupplierProfile(currentSupplier)}
</current_supplier>`);
  }

  if (currentSupplier) {
    sections.push(`<quality_comparison>
${buildQualityComparison(currentSupplier, supplierProfiles, currentSupplierId)}
</quality_comparison>`);
  }

  if (currentSupplier) {
    sections.push(`<risk_assessment>
${buildRiskAssessment(currentSupplier, supplierProfiles, currentSupplierId)}
</risk_assessment>`);
  }

  const cashFlowAnalysis = buildCashFlowAnalysis(params);
  if (cashFlowAnalysis) {
    sections.push(`<cash_flow_analysis>
${cashFlowAnalysis}
</cash_flow_analysis>`);
  }

  if (hasOtherOffers) {
    sections.push(`<competitive_intelligence>
${buildCompetitiveIntelligence(params)}
</competitive_intelligence>`);
  }

  const historyText = await summarizeAndTrimHistory(conversationHistory);
  sections.push(`<conversation_history>
${historyText}
</conversation_history>`);

  // ━━━ INSTRUCTION SECTIONS (bottom) — lean role + strategy ━━━

  sections.push(`<role>
You are Alex, a senior procurement specialist at Valden Outdoor. Round ${roundNumber} of ${totalRounds} with ${supplierName}. Find the best tradeoff across cost, quality, reliability, and cash flow. Use specific numbers. NEVER reveal competitor names — say "another supplier". NEVER reveal internal quality scores/ratings (e.g., "4/5 quality") or supplier performance metrics — these are confidential assessments.
</role>`);

  if (userNotes) {
    sections.push(`<user_priorities>
${userNotes}
</user_priorities>`);
  }

  sections.push(`<strategy>
${buildRoundStrategy(roundNumber, totalRounds, hasOtherOffers, conversationHistory.length)}
</strategy>`);

  return sections.join("\n\n");
}

// ─── Compact Pillar Contexts (to reduce token count per LLM call) ───────────

export interface PillarContexts {
  negotiator: string;
  riskAnalyst: string;
  productCost: string;
}

/**
 * Builds compact, pillar-specific context summaries instead of sending the
 * full context to each pillar. This cuts per-pillar tokens by ~70%.
 */
export function buildPillarContexts(
  params: BuildBrandContextParams,
): PillarContexts {
  const {
    currentSupplierId,
    quotationItems,
    userNotes,
    supplierProfiles,
    allOffers,
    roundNumber,
    totalRounds,
  } = params;

  const currentSupplier = supplierProfiles.find(
    (p) => p.id === currentSupplierId,
  );
  const supplierName = currentSupplier?.name ?? "the supplier";
  const baselineTotal = quotationItems.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );

  // ── Shared competitive summary (compact) ──
  const competitiveLines: string[] = [];
  for (const [id, offer] of allOffers.entries()) {
    if (id === currentSupplierId) continue;
    const label = anonymizeSupplierName(
      id,
      currentSupplierId,
      supplierProfiles,
    );
    competitiveLines.push(
      `${label}: $${offer.totalCost.toLocaleString()} total, ${offer.leadTimeDays}d lead, ${offer.paymentTerms} terms`,
    );
  }
  const competitiveSummary =
    competitiveLines.length > 0
      ? `Competing offers:\n${competitiveLines.join("\n")}`
      : "No competing offers yet.";

  // ── Current supplier summary ──
  const supplierSummary = currentSupplier
    ? `${supplierName} (${currentSupplier.code}): [INTERNAL: quality ${currentSupplier.qualityRating}/5], ${currentSupplier.priceLevel} price, ${currentSupplier.leadTimeDays}d lead, ${currentSupplier.paymentTerms} terms`
    : "";

  // ── Current offer ──
  const currentOffer = allOffers.get(currentSupplierId);
  const currentOfferLine = currentOffer
    ? `Current offer from ${supplierName}: $${currentOffer.totalCost.toLocaleString()} total, ${currentOffer.leadTimeDays}d lead, ${currentOffer.paymentTerms} terms`
    : `Baseline from ${supplierName}: $${baselineTotal.toLocaleString()} total`;

  const roundLine = `Round ${roundNumber} of ${totalRounds}`;
  const priorityLine = userNotes ? `User priorities: ${userNotes}` : "";

  // ── Pillar 1: Negotiator — needs competitive intel + current offer ──
  const negotiator = [
    roundLine,
    supplierSummary,
    currentOfferLine,
    competitiveSummary,
    priorityLine,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── Pillar 2: Risk Analyst — needs supplier metrics + comparison + price discrepancy analysis ──
  const riskMetrics: string[] = [];
  for (const p of supplierProfiles) {
    const label =
      p.id === currentSupplierId
        ? `${p.name} (current)`
        : anonymizeSupplierName(p.id, currentSupplierId, supplierProfiles);
    const offer = allOffers.get(p.id);
    const offerLine = offer
      ? `, current offer: $${offer.totalCost.toLocaleString()}, ${offer.leadTimeDays}d, ${offer.paymentTerms}`
      : "";
    riskMetrics.push(
      `${label}: [INTERNAL quality ${p.qualityRating}/5], priceLevel ${p.priceLevel}, lead ${p.leadTimeDays}d, terms ${p.paymentTerms}${offerLine}`,
    );
  }

  // Price discrepancy analysis — flag if any supplier's offer is wildly different
  const priceDiscrepancyLines: string[] = [];
  const offerValues = Array.from(allOffers.entries()).map(([id, o]) => ({
    id,
    totalCost: o.totalCost,
  }));
  if (offerValues.length >= 2) {
    const sorted = [...offerValues].sort((a, b) => a.totalCost - b.totalCost);
    const cheapest = sorted[0];
    const mostExpensive = sorted[sorted.length - 1];
    const ratio = mostExpensive.totalCost / cheapest.totalCost;
    const gap = mostExpensive.totalCost - cheapest.totalCost;
    if (ratio >= 2.0) {
      const cheapLabel =
        cheapest.id === currentSupplierId
          ? supplierName
          : anonymizeSupplierName(
              cheapest.id,
              currentSupplierId,
              supplierProfiles,
            );
      const expLabel =
        mostExpensive.id === currentSupplierId
          ? supplierName
          : anonymizeSupplierName(
              mostExpensive.id,
              currentSupplierId,
              supplierProfiles,
            );
      priceDiscrepancyLines.push(
        `🚨 EXTREME PRICE DISCREPANCY: ${expLabel} ($${mostExpensive.totalCost.toLocaleString()}) is ${ratio.toFixed(1)}x more expensive than ${cheapLabel} ($${cheapest.totalCost.toLocaleString()}) — a $${gap.toLocaleString()} gap. This is abnormal even accounting for quality differences. Investigate: is the expensive supplier quoting different quantities, adding unnecessary items, or inflating unit prices?`,
      );
    } else if (ratio >= 1.5) {
      priceDiscrepancyLines.push(
        `⚠️ LARGE PRICE GAP: ${ratio.toFixed(1)}x difference between cheapest ($${cheapest.totalCost.toLocaleString()}) and most expensive ($${mostExpensive.totalCost.toLocaleString()}) offers — a $${gap.toLocaleString()} gap. Verify all suppliers are quoting the same quantities and scope.`,
      );
    }
  }

  const riskAnalyst = [
    roundLine,
    `Supplier risk metrics:\n${riskMetrics.join("\n")}`,
    currentOfferLine,
    ...(priceDiscrepancyLines.length > 0
      ? [`PRICE DISCREPANCY FLAGS:\n${priceDiscrepancyLines.join("\n")}`]
      : []),
    `Baseline quotation total: $${baselineTotal.toLocaleString()} (${quotationItems.length} items, ${quotationItems.reduce((s, i) => s + i.quantity, 0).toLocaleString()} total units)`,
    priorityLine,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── Pillar 3: Product/Cost — needs SKU data + cash flow ──
  const topSkus = quotationItems
    .slice(0, 10)
    .map(
      (item) =>
        `${formatSkuRef(item.rawSku, item.rawDescription)} | Qty ${item.quantity} | $${item.unitPrice.toFixed(2)}/unit | $${item.totalPrice.toFixed(2)} total`,
    )
    .join("\n");
  const skuNote =
    quotationItems.length > 10
      ? `\n(+${quotationItems.length - 10} more items, baseline total: $${baselineTotal.toLocaleString()})`
      : "";

  const cashFlowSummary = buildCashFlowAnalysis(params);

  const productCost = [
    roundLine,
    `SKU pricing:\n${topSkus}${skuNote}`,
    currentOfferLine,
    cashFlowSummary ? `Cash flow analysis:\n${cashFlowSummary}` : "",
    competitiveSummary,
    priorityLine,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { negotiator, riskAnalyst, productCost };
}

// ─── Structured Context Builder (for SSE event — typed, not text) ───────────

export function buildBrandContextStructured(
  params: BuildBrandContextParams,
): ContextSections {
  const {
    currentSupplierId,
    quotationItems,
    userNotes,
    supplierProfiles,
    allOffers,
    conversationHistory,
    roundNumber,
    totalRounds,
  } = params;

  const currentSupplier = supplierProfiles.find(
    (p) => p.id === currentSupplierId,
  );
  const hasOtherOffers = Array.from(allOffers.keys()).some(
    (id) => id !== currentSupplierId,
  );

  // Quotation items (with tiers if available)
  const items = quotationItems.map((item) => ({
    sku: item.rawSku,
    description: item.rawDescription,
    qty: item.quantity, // Single baseline quantity only (no tier details)
    unitPrice: item.unitPrice, // Single unit price only
    totalPrice: item.totalPrice,
  }));

  // Supplier profile
  const profile = currentSupplier
    ? {
        name: currentSupplier.name,
        code: currentSupplier.code,
        quality: currentSupplier.qualityRating,
        priceLevel: currentSupplier.priceLevel,
        leadTime: currentSupplier.leadTimeDays,
        terms: currentSupplier.paymentTerms,
      }
    : null;

  // Competitive intel
  const competitiveIntel: ContextSections["competitiveIntel"] = [];
  for (const [id, offer] of allOffers.entries()) {
    if (id === currentSupplierId) continue;
    const otherProfile = supplierProfiles.find((p) => p.id === id);
    const label = anonymizeSupplierName(
      id,
      currentSupplierId,
      supplierProfiles,
    );
    competitiveIntel.push({
      label: otherProfile ? `${label} (${otherProfile.code})` : label,
      totalCost: offer.totalCost,
      leadTime: offer.leadTimeDays,
      terms: offer.paymentTerms,
      concessions: offer.concessions ?? [],
    });
  }

  // Cash flow summary
  const cashFlowSummary = buildCashFlowAnalysis(params);

  // Risk flags
  const riskFlags: string[] = [];
  if (currentSupplier) {
    const fastestLead = Math.min(
      ...supplierProfiles.map((p) => p.leadTimeDays),
    );
    if (currentSupplier.leadTimeDays > fastestLead * 2) {
      riskFlags.push(
        `Lead time ${currentSupplier.leadTimeDays}d is ${(currentSupplier.leadTimeDays / fastestLead).toFixed(1)}x the fastest option`,
      );
    }
    const upfrontPct =
      parseInt(currentSupplier.paymentTerms.split("/")[0], 10) || 0;
    if (upfrontPct >= 100) {
      riskFlags.push(`100% upfront payment required — high cash flow exposure`);
    }
  }

  // Round strategy
  const roundStrategy = buildRoundStrategy(
    roundNumber,
    totalRounds,
    hasOtherOffers,
    conversationHistory.length,
  );

  return {
    quotationItems: items,
    supplierProfile: profile,
    competitiveIntel,
    cashFlowSummary,
    riskFlags,
    roundStrategy,
    userPriorities: userNotes || "",
  };
}
