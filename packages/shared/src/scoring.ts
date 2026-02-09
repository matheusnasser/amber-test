// ─── Deterministic Offer Scoring ──────────────────────────────────────────────
//
// Computes 0-100 scores per dimension from raw offer data + supplier profile.
// Uses relative normalization across the pool of current offers.
// No LLM needed — enables radar charts at every stage of negotiation.

export interface OfferScore {
  price: number; // 0-100, lower totalCost = higher
  quality: number; // 0-100, from supplier qualityRating
  leadTime: number; // 0-100, faster = higher
  cashFlow: number; // 0-100, lower cash flow cost = higher
  risk: number; // 0-100, better on-time + lower defect = higher
  weighted: number; // 0-100, weighted by mode
}

export interface ScoredOffer {
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  totalCost: number;
  leadTimeDays: number;
  paymentTerms: string;
  concessions: string[];
  isXlsxSource: boolean;
  roundNumber: number;
  score: OfferScore;
}

export interface SupplierProfileForScoring {
  qualityRating: number;
  leadTimeDays: number;
  paymentTerms: string;
}

export interface OfferForScoring {
  totalCost: number;
  leadTimeDays: number;
  paymentTerms: string;
}

// ─── Scoring Weights ─────────────────────────────────────────────────────────

const MODE_WEIGHTS: Record<
  string,
  { price: number; quality: number; leadTime: number; cashFlow: number; risk: number }
> = {
  balanced: { price: 0.25, quality: 0.2, leadTime: 0.2, cashFlow: 0.15, risk: 0.2 },
  cost: { price: 0.35, quality: 0.15, leadTime: 0.15, cashFlow: 0.2, risk: 0.15 },
  quality: { price: 0.15, quality: 0.35, leadTime: 0.15, cashFlow: 0.15, risk: 0.2 },
  speed: { price: 0.15, quality: 0.15, leadTime: 0.35, cashFlow: 0.15, risk: 0.2 },
  cashflow: { price: 0.2, quality: 0.15, leadTime: 0.15, cashFlow: 0.35, risk: 0.15 },
  custom: { price: 0.25, quality: 0.2, leadTime: 0.2, cashFlow: 0.15, risk: 0.2 },
};

// ─── Cash Flow Cost ──────────────────────────────────────────────────────────

function calculateCashFlowCostFromTerms(
  totalCost: number,
  paymentTerms: string,
  leadTimeDays: number,
): number {
  const annualRate = 0.08;
  const dailyRate = annualRate / 365;

  const parts = paymentTerms
    .split("/")
    .map(Number)
    .filter((n) => !isNaN(n));
  if (parts.length === 0) return 0;

  return parts.reduce((cost, pct, index) => {
    const daysLocked = Math.max(
      0,
      leadTimeDays * (1 - index / parts.length),
    );
    const amount = totalCost * (pct / 100);
    return cost + amount * daysLocked * dailyRate;
  }, 0);
}

// ─── Normalize helper ────────────────────────────────────────────────────────

function normalize(value: number, min: number, max: number, invert: boolean): number {
  if (max === min) return 75; // all equal → decent score
  const ratio = (value - min) / (max - min);
  const score = invert ? (1 - ratio) * 100 : ratio * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Score a single offer (relative to pool) ────────────────────────────────

export function scoreOffer(
  offer: OfferForScoring,
  profile: SupplierProfileForScoring,
  allOffers: OfferForScoring[],
  allProfiles: SupplierProfileForScoring[],
  mode: string = "balanced",
): OfferScore {
  // Collect ranges from all offers
  const costs = allOffers.map((o) => o.totalCost);
  const leads = allOffers.map((o) => o.leadTimeDays);
  const cashFlowCosts = allOffers.map((o, i) =>
    calculateCashFlowCostFromTerms(o.totalCost, o.paymentTerms, o.leadTimeDays),
  );

  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const minLead = Math.min(...leads);
  const maxLead = Math.max(...leads);
  const minCF = Math.min(...cashFlowCosts);
  const maxCF = Math.max(...cashFlowCosts);

  const offerCF = calculateCashFlowCostFromTerms(
    offer.totalCost,
    offer.paymentTerms,
    offer.leadTimeDays,
  );

  // Price: lower is better (invert)
  const price = normalize(offer.totalCost, minCost, maxCost, true);

  // Quality: absolute from profile (0-5 → 0-100)
  const quality = Math.round((profile.qualityRating / 5) * 100);

  // Lead time: lower is better (invert)
  const leadTime = normalize(offer.leadTimeDays, minLead, maxLead, true);

  // Cash flow: lower cost is better (invert)
  const cashFlow = normalize(offerCF, minCF, maxCF, true);

  // Risk: derived from quality rating and lead time reliability
  const qualityFactor = profile.qualityRating / 5; // 0-1
  const leadTimeFactor = Math.max(0, Math.min(1, 1 - (profile.leadTimeDays - 15) / 50)); // faster = better
  const risk = Math.round(
    (qualityFactor * 0.6 + leadTimeFactor * 0.4) * 100,
  );

  // Weighted score
  const weights = MODE_WEIGHTS[mode] ?? MODE_WEIGHTS.balanced;
  const weighted = Math.round(
    price * weights.price +
      quality * weights.quality +
      leadTime * weights.leadTime +
      cashFlow * weights.cashFlow +
      risk * weights.risk,
  );

  return { price, quality, leadTime, cashFlow, risk, weighted };
}

// ─── Score all offers at once ────────────────────────────────────────────────

export function scoreAllOffers(
  entries: {
    supplierId: string;
    supplierName: string;
    supplierCode: string;
    offer: OfferForScoring;
    profile: SupplierProfileForScoring;
    isXlsxSource: boolean;
    roundNumber: number;
  }[],
  mode: string = "balanced",
): ScoredOffer[] {
  const allOffers = entries.map((e) => e.offer);
  const allProfiles = entries.map((e) => e.profile);

  return entries.map((entry) => ({
    supplierId: entry.supplierId,
    supplierName: entry.supplierName,
    supplierCode: entry.supplierCode,
    totalCost: entry.offer.totalCost,
    leadTimeDays: entry.offer.leadTimeDays,
    paymentTerms: entry.offer.paymentTerms,
    concessions: [],
    isXlsxSource: entry.isXlsxSource,
    roundNumber: entry.roundNumber,
    score: scoreOffer(entry.offer, entry.profile, allOffers, allProfiles, mode),
  }));
}
