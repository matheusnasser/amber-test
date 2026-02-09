/**
 * Business rules and constants configuration
 * Centralized location for all business logic constants
 */

export const BUSINESS_RULES = {
  /**
   * Cash flow and financial calculations
   */
  cashFlow: {
    annualRate: 0.08, // 8% annual cost of capital
    dailyRate: 0.08 / 365,
  },

  /**
   * Negotiation settings
   */
  negotiation: {
    maxRounds: 5,
    defaultRounds: 4,
    curveballRound: 2, // Which round to inject curveball
    curveballCapacityReduction: 0.6, // 60% capacity for affected supplier
  },

  /**
   * Scoring weights by negotiation mode
   */
  scoring: {
    weights: {
      balanced: { cost: 0.3, quality: 0.25, leadTime: 0.25, terms: 0.2 },
      cost: { cost: 0.4, quality: 0.15, leadTime: 0.15, terms: 0.2 },
      quality: { cost: 0.15, quality: 0.4, leadTime: 0.15, terms: 0.2 },
      speed: { cost: 0.15, quality: 0.15, leadTime: 0.4, terms: 0.2 },
      cashflow: { cost: 0.2, quality: 0.15, leadTime: 0.15, terms: 0.4 },
      custom: { cost: 0.3, quality: 0.25, leadTime: 0.25, terms: 0.2 }, // Same as balanced
    },
  },

  /**
   * Split order evaluation
   */
  splitOrder: {
    overheadPenalty: 0.05, // 5% penalty for coordination overhead
    worthItThreshold: 1.0, // Split must score better than single supplier
  },

  /**
   * Product matching thresholds
   */
  matching: {
    autoAcceptThreshold: 0.85, // Auto-accept if confidence >= 85%
    reviewThreshold: 0.5, // Review if confidence 50-84%
    actionNeededThreshold: 0.5, // Action needed if < 50%
  },

  /**
   * Agent response constraints
   */
  agent: {
    maxResponseWords: 100,
    minResponseWords: 80,
    maxResponseTokens: 250,
  },

  /**
   * Supplier pricing ranges (multipliers on baseline)
   */
  pricing: {
    cheapest: { low: 0.85, high: 1.0 }, // 15% discount to baseline
    expensive: { low: 1.15, high: 1.4 }, // 15-40% premium
    mid: { low: 0.95, high: 1.2 }, // 5% discount to 20% premium
  },

  /**
   * AI model concurrency limits (prevents rate limiting)
   */
  concurrency: {
    haiku: 3, // Max concurrent Haiku calls (stays under 10K output tokens/min)
    sonnet: 2, // Max concurrent Sonnet calls
  },
} as const;

/**
 * Get scoring weights for a specific negotiation mode
 */
export function getScoringWeights(mode: string): {
  cost: number;
  quality: number;
  leadTime: number;
  terms: number;
} {
  return (
    BUSINESS_RULES.scoring.weights[
      mode as keyof typeof BUSINESS_RULES.scoring.weights
    ] || BUSINESS_RULES.scoring.weights.balanced
  );
}

/**
 * Get pricing range for a supplier price level
 */
export function getPricingRange(priceLevel: string): {
  low: number;
  high: number;
} {
  if (priceLevel === "cheapest") return BUSINESS_RULES.pricing.cheapest;
  if (priceLevel === "expensive") return BUSINESS_RULES.pricing.expensive;
  return BUSINESS_RULES.pricing.mid;
}

/**
 * Get AI model concurrency limits
 */
export function getConcurrencyLimits(): {
  haiku: number;
  sonnet: number;
} {
  return BUSINESS_RULES.concurrency;
}
