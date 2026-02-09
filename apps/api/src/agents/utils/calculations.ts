/**
 * Shared business calculation utilities
 */

import type { SupplierProfile } from "../types";

/**
 * Calculate the opportunity cost of capital locked up in payment terms.
 * Uses configurable annual rate with daily compounding.
 *
 * Payment term patterns:
 *  - "33/33/33" → 3 equal installments
 *  - "40/60"    → 40% at order, 60% at delivery
 *  - "100"      → 100% upfront
 *  - "Net-30"   → pay 30 days after delivery (negative cost = savings)
 *
 * @param totalCost - Total order cost
 * @param paymentTerms - Payment terms string
 * @param leadTimeDays - Lead time in days
 * @param annualRate - Annual cost of capital (default 8%)
 * @returns Cash flow cost in dollars (negative = savings)
 */
export function calculateCashFlowCost(
  totalCost: number,
  paymentTerms: string,
  leadTimeDays: number,
  annualRate = 0.08,
): number {
  const dailyRate = annualRate / 365;
  const terms = paymentTerms.trim().toLowerCase();

  // Net-N terms: payment after delivery (savings)
  const netMatch = terms.match(/net[- ]?(\d+)/i);
  if (netMatch) {
    const netDays = parseInt(netMatch[1], 10);
    return -(totalCost * netDays * dailyRate);
  }

  // "N-day" pattern
  const dayMatch = terms.match(/(\d+)[- ]?day/i);
  if (dayMatch && !terms.includes("/")) {
    const netDays = parseInt(dayMatch[1], 10);
    return -(totalCost * netDays * dailyRate);
  }

  // Split terms
  const parts = paymentTerms
    .split("/")
    .map(Number)
    .filter((n) => !isNaN(n) && n > 0);

  if (parts.length === 0) return 0;

  // 100% upfront
  if (parts.length === 1 && parts[0] >= 100) {
    return totalCost * leadTimeDays * dailyRate;
  }

  // Installment schedule
  return parts.reduce((cost, pct, index) => {
    const paymentDay = (index / parts.length) * leadTimeDays;
    const daysLocked = Math.max(0, leadTimeDays - paymentDay);
    const amount = totalCost * (pct / 100);
    return cost + amount * daysLocked * dailyRate;
  }, 0);
}

/**
 * Compute price range multipliers based on supplier characteristics
 */
export function computePriceRange(profile: SupplierProfile): {
  low: number;
  high: number;
} {
  // Price level determines base range
  if (profile.priceLevel === "cheapest") {
    return { low: 0.85, high: 1.0 }; // 15% discount to baseline
  }
  if (profile.priceLevel === "expensive") {
    return { low: 1.15, high: 1.4 }; // 15-40% premium
  }
  // mid-range
  return { low: 0.95, high: 1.2 }; // 5% discount to 20% premium
}

/**
 * Evaluate whether a split order justifies the overhead penalty
 */
export function evaluateSplitOverhead(
  singleSupplierScore: number,
  splitSuppliers: Array<{ supplier: string; score: number; pct: number }>,
  overheadPenalty = 0.05,
): { worthIt: boolean; adjustedScores: typeof splitSuppliers } {
  // Apply overhead penalty to each split supplier
  const adjustedScores = splitSuppliers.map((s) => ({
    ...s,
    score: s.score * (1 - overheadPenalty),
  }));

  // Weighted average of split scores
  const splitWeightedScore = adjustedScores.reduce(
    (sum, s) => sum + (s.score * s.pct) / 100,
    0,
  );

  // Worth it if weighted split score > single supplier score
  return {
    worthIt: splitWeightedScore > singleSupplierScore,
    adjustedScores,
  };
}
