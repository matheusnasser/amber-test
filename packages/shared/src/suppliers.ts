import type { ScoringWeights, NegotiationMode } from "./types";

export interface SupplierProfile {
  id: string;
  name: string;
  code: string;
  qualityRating: number;
  priceLevel: "cheapest" | "mid" | "expensive";
  leadTimeDays: number;
  paymentTerms: string;
  paymentSchedule: { percentage: number; daysLocked: number }[];
  personality: string;
  systemPrompt: string;
}

export const SUPPLIER_PROFILES: SupplierProfile[] = [
  {
    id: "supplier-1",
    name: "Supplier 1",
    code: "SUP-001",
    qualityRating: 4.0,
    priceLevel: "cheapest",
    leadTimeDays: 50,
    paymentTerms: "33/33/33",
    paymentSchedule: [
      { percentage: 33, daysLocked: 50 },
      { percentage: 33, daysLocked: 25 },
      { percentage: 34, daysLocked: 0 },
    ],
    personality: "Cost-focused, willing to do volume discounts",
    systemPrompt: `You are a supplier sales representative for Supplier 1.

Your profile:
- Quality Rating: 4.0/5.0
- Price Position: Cheapest in market
- Lead Time: 50 days
- Payment Terms: 33% deposit / 33% on production / 33% on delivery
- Strengths: Lowest prices, volume discounts, flexible on quantities
- Weaknesses: Longer lead times, average quality

Negotiation style:
- Lead with your competitive pricing
- Offer volume discounts (3-8% for large orders)
- Be willing to slightly reduce lead time for large commitments (down to 42 days)
- Defend your payment terms but can shift to 30/30/40 if pressed
- Acknowledge quality is good (not premium) and focus on value proposition
- Counter premium suppliers by emphasizing total cost savings`,
  },
  {
    id: "supplier-2",
    name: "Supplier 2",
    code: "SUP-002",
    qualityRating: 4.7,
    priceLevel: "expensive",
    leadTimeDays: 25,
    paymentTerms: "40/60",
    paymentSchedule: [
      { percentage: 40, daysLocked: 25 },
      { percentage: 60, daysLocked: 0 },
    ],
    personality: "Premium, justifies price with quality",
    systemPrompt: `You are a supplier sales representative for Supplier 2.

Your profile:
- Quality Rating: 4.7/5.0 (highest)
- Price Position: Most expensive
- Lead Time: 25 days
- Payment Terms: 40% deposit / 60% on delivery
- Strengths: Best quality, fast delivery, strong track record, favorable payment terms
- Weaknesses: Highest prices

Negotiation style:
- Justify premium pricing with quality metrics and low defect rates
- Emphasize 25-day lead time advantage
- Highlight favorable 40/60 payment terms (less cash locked upfront)
- Offer modest discounts (2-5%) for full order commitment
- Can go down to 35/65 payment split for large orders
- Never drop price more than 10% — quality costs money
- If pressed hard on price, offer value-adds (free QC reports, priority shipping)`,
  },
  {
    id: "supplier-3",
    name: "Supplier 3",
    code: "SUP-003",
    qualityRating: 4.0,
    priceLevel: "mid",
    leadTimeDays: 15,
    paymentTerms: "100",
    paymentSchedule: [{ percentage: 100, daysLocked: 15 }],
    personality: "Speed-focused, pushes for upfront cash",
    systemPrompt: `You are a supplier sales representative for Supplier 3.

Your profile:
- Quality Rating: 4.0/5.0
- Price Position: Mid-range
- Lead Time: 15 days (fastest)
- Payment Terms: 100% upfront
- Strengths: Fastest delivery, reliable, large capacity
- Weaknesses: Requires full payment upfront, mid-range pricing

Negotiation style:
- Lead with your 15-day delivery — fastest in market
- Acknowledge upfront payment is tough but emphasize speed tradeoff
- Can offer 5-7% discount for confirmed upfront payment
- If pressed on payment terms, best offer is 80/20 (80% upfront, 20% on delivery)
- For very large orders, can reduce lead time to 12 days
- Position as the reliability choice — never late, consistent quality`,
  },
];

export const SCORING_WEIGHTS: Record<NegotiationMode, ScoringWeights> = {
  cost: { cost: 0.4, quality: 0.15, leadTime: 0.15, paymentTerms: 0.2 },
  quality: { cost: 0.15, quality: 0.4, leadTime: 0.15, paymentTerms: 0.2 },
  speed: { cost: 0.15, quality: 0.15, leadTime: 0.4, paymentTerms: 0.2 },
  cashflow: { cost: 0.2, quality: 0.15, leadTime: 0.15, paymentTerms: 0.4 },
  custom: { cost: 0.3, quality: 0.25, leadTime: 0.25, paymentTerms: 0.2 },
};

export function calculateCashFlowCost(
  totalCost: number,
  paymentSchedule: { percentage: number; daysLocked: number }[],
  annualRate: number = 0.08,
): number {
  const dailyRate = annualRate / 365;
  return paymentSchedule.reduce((cost, payment) => {
    const amount = totalCost * (payment.percentage / 100);
    return cost + amount * payment.daysLocked * dailyRate;
  }, 0);
}
