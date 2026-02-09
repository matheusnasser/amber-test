/**
 * Decision Maker Helpers
 * Formatting and data loading utilities for decision analysis
 */

import { prisma } from "@supplier-negotiation/database";
import type { OfferData, SupplierProfile } from "../types";
import { calculateCashFlowCost } from "../utils/calculations";

/**
 * Format supplier offer for LLM prompt
 * Includes pricing, quality metrics, and per-item breakdown
 */
export function formatSupplierOffer(
  offer: OfferData,
  profile: SupplierProfile,
  isAffected: boolean,
  quotationItems?: Array<{
    rawSku: string;
    rawDescription: string;
    quantity: number;
    unitPrice: number;
  }>,
): string {
  const cashFlowCost = calculateCashFlowCost(
    offer.totalCost,
    offer.paymentTerms,
    offer.leadTimeDays,
  );

  const totalBaselineQty =
    quotationItems?.reduce((s, i) => s + i.quantity, 0) ?? 0;
  const totalOfferedQty = offer.items.reduce((s, i) => s + i.quantity, 0);

  let summary = `${profile.name} (${profile.code}, ID: ${profile.id}):
  Quality: ${profile.qualityRating}/5, Price Level: ${profile.priceLevel}
  Offer: $${offer.totalCost.toLocaleString()}, Lead: ${offer.leadTimeDays}d, Terms: ${offer.paymentTerms}
  Cash Flow Cost: $${cashFlowCost.toFixed(2)}, Effective Cost: $${(offer.totalCost + cashFlowCost).toFixed(2)}
  Total Units Quoted: ${totalOfferedQty.toLocaleString()} (baseline: ${totalBaselineQty.toLocaleString()})
  Items: ${offer.items.length}
  Concessions: ${offer.concessions.length > 0 ? offer.concessions.join(", ") : "none"}`;

  // Per-item breakdown
  if (offer.items.length > 0 && quotationItems) {
    summary += `\n  Per-Item Breakdown:`;
    for (const item of offer.items) {
      const baseItem = quotationItems.find(
        (qi) => qi.rawSku.toUpperCase() === item.sku.toUpperCase(),
      );
      const basePrice = baseItem?.unitPrice ?? 0;
      const delta =
        basePrice > 0
          ? (((item.unitPrice - basePrice) / basePrice) * 100).toFixed(1)
          : "N/A";
      summary += `\n    ${item.sku}: $${item.unitPrice.toFixed(2)}/unit × ${item.quantity} = $${(item.unitPrice * item.quantity).toLocaleString()} (baseline: $${basePrice.toFixed(2)}/unit, ${delta}%)`;
    }
  }

  if (isAffected) {
    summary += `\n  AFFECTED BY CURVEBALL — can only fulfill 60% of the order`;
  }

  return summary;
}

/**
 * Load latest offers from database for all suppliers in a negotiation
 * Optionally filter by phase (initial, post_curveball)
 */
export async function loadLatestOffers(
  negotiationId: string,
  phase?: string,
): Promise<Map<string, { offer: OfferData; profile: SupplierProfile }>> {
  const whereClause: Record<string, unknown> = { negotiationId };
  if (phase) whereClause.phase = phase;

  const rounds = await prisma.negotiationRound.findMany({
    where: whereClause,
    orderBy: { roundNumber: "desc" },
    include: { supplier: true },
  });

  const offerMap = new Map<
    string,
    { offer: OfferData; profile: SupplierProfile }
  >();

  for (const round of rounds) {
    if (!offerMap.has(round.supplierId) && round.offerData) {
      offerMap.set(round.supplierId, {
        offer: round.offerData as unknown as OfferData,
        profile: {
          id: round.supplier.id,
          name: round.supplier.name,
          code: round.supplier.code,
          qualityRating: round.supplier.qualityRating,
          priceLevel: round.supplier.priceLevel,
          leadTimeDays: round.supplier.leadTimeDays,
          paymentTerms: round.supplier.paymentTerms,
          isSimulated: round.supplier.isSimulated,
        },
      });
    }
  }

  return offerMap;
}
