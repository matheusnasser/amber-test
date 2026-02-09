/**
 * SKU Allocation Engine
 * Handles intelligent distribution of SKUs across suppliers
 */

import type { OfferData } from "../types";
import { calculateCashFlowCost } from "./calculations";

export interface QuotationItemForAllocation {
  rawSku: string;
  rawDescription: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  productId: string | null;
}

/**
 * Allocate SKUs to suppliers based on target percentages and cost optimization
 * Uses greedy algorithm to match target allocations while minimizing landed cost
 */
export function allocateSkusToSuppliers(
  quotationItems: QuotationItemForAllocation[],
  supplierOffers: Map<string, OfferData>,
  targetAllocations: { supplierId: string; targetPct: number }[],
): Map<string, QuotationItemForAllocation[]> {
  // Step 1: Calculate per-SKU landed cost for each supplier
  const skuCosts = new Map<string, Map<string, number>>();
  for (const item of quotationItems) {
    const costs = new Map<string, number>();
    for (const [supplierId, offer] of supplierOffers) {
      const offerItem = offer.items.find(
        (oi) => oi.sku.toUpperCase() === item.rawSku.toUpperCase(),
      );
      if (!offerItem) continue;

      // Landed cost = FOB cost + cash flow cost
      const fobCost = offerItem.unitPrice * item.quantity;
      const cashFlowCost = calculateCashFlowCost(
        fobCost,
        offer.paymentTerms,
        offer.leadTimeDays,
      );
      const landedCost = fobCost + cashFlowCost;

      costs.set(supplierId, landedCost);
    }
    skuCosts.set(item.rawSku, costs);
  }

  // Step 2: Sort SKUs by total value (descending) - allocate high-value items first
  const sortedSkus = [...quotationItems].sort(
    (a, b) => b.totalPrice - a.totalPrice,
  );

  // Step 3: Greedy allocation to match target percentages
  const allocations = new Map<string, QuotationItemForAllocation[]>();
  const runningTotals = new Map<string, number>();

  for (const alloc of targetAllocations) {
    allocations.set(alloc.supplierId, []);
    runningTotals.set(alloc.supplierId, 0);
  }

  const totalOrderValue = quotationItems.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );

  for (const item of sortedSkus) {
    const costs = skuCosts.get(item.rawSku);
    if (!costs || costs.size === 0) continue;

    // Find which supplier assignment gets us closest to target percentages
    let bestSupplierId: string | null = null;
    let bestScore = -Infinity;

    for (const alloc of targetAllocations) {
      if (!costs.has(alloc.supplierId)) continue;

      const currentPct =
        (runningTotals.get(alloc.supplierId)! / totalOrderValue) * 100;
      const afterPct =
        ((runningTotals.get(alloc.supplierId)! + item.totalPrice) /
          totalOrderValue) *
        100;

      // Score = closeness to target - cost penalty
      const distanceToTarget = Math.abs(afterPct - alloc.targetPct);
      const costForThisSupplier = costs.get(alloc.supplierId) ?? Infinity;
      const relativeCost =
        costForThisSupplier / Math.min(...Array.from(costs.values()));

      const score = -distanceToTarget - relativeCost * 5;

      if (score > bestScore) {
        bestScore = score;
        bestSupplierId = alloc.supplierId;
      }
    }

    if (bestSupplierId) {
      allocations.get(bestSupplierId)!.push(item);
      runningTotals.set(
        bestSupplierId,
        runningTotals.get(bestSupplierId)! + item.totalPrice,
      );
    }
  }

  return allocations;
}

/**
 * Reallocate SKUs after a curveball event (e.g., supplier capacity constraint)
 * Keeps high-value items with affected supplier, redistributes overflow
 */
export function reallocateSkusAfterCurveball(
  currentAllocations: Map<string, QuotationItemForAllocation[]>,
  affectedSupplierId: string,
  newCapacityPct: number,
  supplierOffers: Map<string, OfferData>,
  allQuotationItems: QuotationItemForAllocation[],
): Map<string, QuotationItemForAllocation[]> {
  const affectedItems = currentAllocations.get(affectedSupplierId) ?? [];
  const totalValueAssigned = affectedItems.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );
  const newMaxValue = totalValueAssigned * (newCapacityPct / 100);

  // Sort items by value (descending) - keep high-value items with affected supplier
  const sortedItems = [...affectedItems].sort(
    (a, b) => b.totalPrice - a.totalPrice,
  );

  const kept: QuotationItemForAllocation[] = [];
  const reassigned: QuotationItemForAllocation[] = [];
  let runningValue = 0;

  for (const item of sortedItems) {
    if (runningValue + item.totalPrice <= newMaxValue) {
      kept.push(item);
      runningValue += item.totalPrice;
    } else {
      reassigned.push(item);
    }
  }

  // Update allocations
  const updatedAllocations = new Map(currentAllocations);
  updatedAllocations.set(affectedSupplierId, kept);

  // Reassign to other suppliers using greedy allocation
  if (reassigned.length > 0) {
    const otherSuppliers = Array.from(currentAllocations.keys()).filter(
      (id) => id !== affectedSupplierId,
    );
    const targetAllocations = otherSuppliers.map((id) => ({
      supplierId: id,
      targetPct: 100 / otherSuppliers.length,
    }));

    const reassignedAllocations = allocateSkusToSuppliers(
      reassigned,
      supplierOffers,
      targetAllocations,
    );

    // Merge reassigned items into existing allocations
    for (const [supplierId, items] of reassignedAllocations) {
      const existing = updatedAllocations.get(supplierId) ?? [];
      updatedAllocations.set(supplierId, [...existing, ...items]);
    }
  }

  return updatedAllocations;
}
