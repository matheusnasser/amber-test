/**
 * Shared formatting utilities for the web app
 */

/**
 * Calculate the opportunity cost of capital locked up in payment terms.
 * Uses 8% annual rate with daily compounding.
 *
 * Payment term patterns:
 *  - "33/33/33" → 3 equal installments at order, mid-production, delivery
 *  - "40/60"    → 40% at order, 60% at delivery
 *  - "100"      → 100% upfront
 *  - "Net-30"   → pay 30 days after delivery (negative cost = savings)
 *  - "Net-60"   → pay 60 days after delivery
 *  - "120-day"  → Net-120 days
 *
 * @param totalCost - Total order cost
 * @param paymentTerms - Payment terms string
 * @param leadTimeDays - Lead time in days
 * @param annualRate - Annual cost of capital (default 8%)
 * @returns Estimated cash flow cost in dollars (negative = savings)
 */
export function calculateCashFlowCost(
  totalCost: number,
  paymentTerms: string,
  leadTimeDays: number,
  annualRate = 0.08
): number {
  const dailyRate = annualRate / 365;
  const terms = paymentTerms.trim().toLowerCase();

  // Net-N terms: payment happens N days after delivery → capital is FREE during lead time
  const netMatch = terms.match(/net[- ]?(\d+)/i);
  if (netMatch) {
    const netDays = parseInt(netMatch[1], 10);
    // With net terms, you pay AFTER delivery. This is a benefit (negative cost).
    return -(totalCost * netDays * dailyRate);
  }

  // "N-day" pattern (e.g. "120-day") → treat as Net-N
  const dayMatch = terms.match(/(\d+)[- ]?day/i);
  if (dayMatch && !terms.includes("/")) {
    const netDays = parseInt(dayMatch[1], 10);
    return -(totalCost * netDays * dailyRate);
  }

  // Split terms: "33/33/33", "40/60", "100"
  const parts = paymentTerms
    .split("/")
    .map(Number)
    .filter((n) => !isNaN(n) && n > 0);

  if (parts.length === 0) return 0;

  // 100% upfront
  if (parts.length === 1 && parts[0] >= 100) {
    return totalCost * leadTimeDays * dailyRate;
  }

  // Installment schedule: first payment at order, subsequent spaced evenly through lead time
  return parts.reduce((cost, pct, index) => {
    const paymentDay = (index / parts.length) * leadTimeDays;
    const daysLocked = Math.max(0, leadTimeDays - paymentDay);
    const amount = totalCost * (pct / 100);
    return cost + amount * daysLocked * dailyRate;
  }, 0);
}

/**
 * Format a number as USD currency
 *
 * @param value - Number to format
 * @returns Formatted string (e.g., "$1,234.56")
 */
export function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
