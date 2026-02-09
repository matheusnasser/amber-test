// ─── Parser Types ───────────────────────────────────────────────────────────

export interface XlsxGrid {
  grid: string[][];
  boldCells: [number, number][];
  sheetName: string;
}

export interface RawParsedItem {
  rawSku: string;
  rawDescription: string;
  rawQuantity: string;
  rawUnitPrice: string;
  rawTotalPrice: string;
}

// ─── Matching Types ─────────────────────────────────────────────────────────

export type MatchMethod = "exact_sku" | "llm_match" | "unmatched";

export interface MatchResult {
  productId: string | null;
  matchConfidence: number;
  matchMethod: MatchMethod | null;
  matchedSku: string | null;
}

export interface ParsedQuotationItem {
  rawSku: string;
  rawDescription: string;
  rawQuantity: string;
  rawUnitPrice: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  match: MatchResult;
}

// ─── Negotiation Types ──────────────────────────────────────────────────────

export type NegotiationMode =
  | "cost"
  | "quality"
  | "speed"
  | "cashflow"
  | "custom";

export type NegotiationStatus =
  | "pending"
  | "negotiating"
  | "curveball"
  | "completed";

export type NegotiationPhase = "initial" | "post_curveball";

export type RoundStatus = "in_progress" | "agreed" | "rejected";

export type MessageRole = "brand_agent" | "supplier_agent";

export interface OfferData {
  totalCost: number;
  items: OfferItem[];
  leadTimeDays: number;
  paymentTerms: string;
  concessions: string[];
}

export interface VolumeTier {
  minQty: number;
  maxQty: number | null;
  unitPrice: number;
}

export interface OfferItem {
  productId: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  volumeTiers?: VolumeTier[];
}

// ─── Scoring Types ──────────────────────────────────────────────────────────

export interface ScoringWeights {
  cost: number;
  quality: number;
  leadTime: number;
  paymentTerms: number;
}

export interface SupplierScore {
  supplierId: string;
  supplierName: string;
  costScore: number;
  qualityScore: number;
  leadTimeScore: number;
  termsScore: number;
  totalScore: number;
}

// ─── Curveball & Decision Types ─────────────────────────────────────────────

export interface CurveballStrategy {
  name: string;
  description: string;
  suppliers: Array<{ supplierId: string; supplierName: string; allocationPct: number }>;
  estimatedCost: number;
  pros: string[];
  cons: string[];
}

export interface CurveballAnalysis {
  impact: string;
  strategies: CurveballStrategy[];
  recommendation: string;
}

export interface AllocationItem {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  volumeTiers?: VolumeTier[];
}

export interface SupplierAllocation {
  supplierId: string;
  supplierName: string;
  allocationPct: number;
  agreedCost: number;
  leadTimeDays: number;
  paymentTerms: string;
  items?: AllocationItem[];
}

export interface FinalRecommendation {
  primarySupplierId: string;
  primarySupplierName: string;
  splitOrder: boolean;
  allocations: SupplierAllocation[];
}

export interface KeyPoint {
  dimension: "price" | "quality" | "leadTime" | "cashFlow" | "risk";
  verdict: string;
  winner: string;
}

export interface FinalDecisionData {
  recommendation: FinalRecommendation;
  comparison: SupplierScore[];
  summary: string;
  keyPoints: KeyPoint[];
  reasoning: string;
  tradeoffs: string;
  purchaseOrderId: string;
  allSupplierAllocations?: SupplierAllocation[];
}

// ─── Final Decision Types (Legacy - kept for compatibility) ────────────────

export interface ComparisonMatrix {
  suppliers: SupplierScore[];
  weights: ScoringWeights;
}

export interface FinalDecision {
  recommendation: string;
  allocations: AllocationRecommendation[];
  comparisonMatrix: ComparisonMatrix;
  reasoning: string;
  tradeoffs: string;
}

export interface AllocationRecommendation {
  supplierId: string;
  supplierName: string;
  allocationPct: number;
  agreedCost: number;
  agreedLeadTimeDays: number;
  agreedPaymentTerms: string;
}

// ─── API Types ──────────────────────────────────────────────────────────────

export interface ParseResponse {
  quotationId: string;
  items: ParsedQuotationItem[];
  matchSummary: {
    total: number;
    matched: number;
    review: number;
    failed: number;
  };
}

export interface NegotiateRequest {
  quotationId: string;
  userNotes?: string;
  mode?: NegotiationMode;
}

export interface CurveballRequest {
  negotiationId: string;
}

// ─── SSE Event Types ────────────────────────────────────────────────────────

export type SSEEventType =
  | "negotiation_start"
  | "round_start"
  | "message"
  | "offer_extracted"
  | "round_end"
  | "curveball_injected"
  | "decision"
  | "negotiation_end"
  | "error";

export interface SSEEvent {
  type: SSEEventType;
  data: unknown;
}
