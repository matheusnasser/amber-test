import type {
  CurveballStrategy,
  CurveballAnalysis,
  SupplierScore,
  AllocationItem,
  SupplierAllocation,
  FinalRecommendation,
  KeyPoint,
  FinalDecisionData,
} from "@supplier-negotiation/shared";
import { apiClient, setToken, removeToken } from "@/lib/axios-client";

// In production, Next.js rewrites proxy /api/* to the Express API.
// In dev, the rewrite also handles it, so we always use relative /api.
const API_BASE = "/api";

// ─── Parse Response Types ────────────────────────────────────────────────────

export interface ValidationFlag {
  itemIndex: number;
  field: string;
  extracted: string | number | null;
  actual: string;
  issue: string;
}

export interface PricingTier {
  sheetName: string;
  sheetIndex: number;
  rawQuantity: number | null;
  rawUnitPrice: number | null;
  rawTotalPrice: number | null;
  rawNotes: string | null;
  validationFlags: ValidationFlag[];
}

export interface CandidateProduct {
  productId: string;
  sku: string;
  name: string;
  color: string;
  confidence: number;
}

export interface GroupedProduct {
  rawSku: string;
  rawDescription: string;
  productId: string | null;
  matchedSku: string | null;
  productName: string | null;
  matchConfidence: number;
  matchMethod: string;
  hasFlaggedIssues: boolean;
  tiers: PricingTier[];
  candidates: CandidateProduct[];
}

export interface MatchSummary {
  totalProducts: number;
  totalRawRows: number;
  autoAccepted: number;
  needsReview: number;
  needsAction: number;
  unmatched: number;
}

export interface SheetInfo {
  sheetName: string;
  sheetIndex: number;
  rows: number;
  cols: number;
}

export interface SheetMetadata {
  supplierName: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  currency: string | null;
  incoterm: string | null;
  validUntil: string | null;
  moq: string | null;
  notes: string | null;
}

export interface SupplierProfile {
  id: string;
  code: string;
  name: string;
  qualityRating: number;
  priceLevel: string;
  leadTimeDays: number;
  paymentTerms: string;
  isSimulated?: boolean;
}

export type SupplierMatchResult =
  | { matched: true; supplier: SupplierProfile }
  | { matched: false; extractedName: string | null };

export interface ParseResponse {
  quotationId: string;
  supplierName: string;
  supplierCode: string;
  supplierMatch: SupplierMatchResult;
  allSuppliers: SupplierProfile[];
  products: GroupedProduct[];
  matchSummary: MatchSummary;
  sheets: SheetInfo[];
  notes: string | null;
  sheetMetadata?: Record<string, SheetMetadata>;
}

// ─── Negotiation Types ───────────────────────────────────────────────────────

export interface VolumeTier {
  minQty: number;
  maxQty: number | null;
  unitPrice: number;
}

export interface OfferItem {
  sku: string;
  unitPrice: number;
  quantity: number;
  volumeTiers?: VolumeTier[];
}

export interface OfferData {
  totalCost: number;
  items: OfferItem[];
  leadTimeDays: number;
  paymentTerms: string;
  concessions: string[];
  conditions: string[];
}

export interface NegotiationMessage {
  id: string;
  role: "brand_agent" | "supplier_agent";
  content: string;
  createdAt: string;
}

export interface NegotiationRound {
  roundNumber: number;
  phase: string;
  offerData: OfferData | null;
  status: string;
  messages: NegotiationMessage[];
}

export interface NegotiationSupplier {
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  rounds: NegotiationRound[];
}

export interface ParseMetadata {
  timings: {
    totalMs: number;
    xlsxReadMs: number;
    llmStructureMs: number;
    validationMs: number;
    matchingMs: number;
  };
  matchSummary: {
    totalProducts: number;
    totalRawRows: number;
    autoAccepted: number;
    needsReview: number;
    needsAction: number;
    unmatched: number;
  };
  sheets: { sheetName: string; rows: number; cols: number }[];
  validation: {
    arithmeticCheckPassed: boolean;
    flagCount: number;
  };
  supplierExtraction: {
    found: boolean;
    name: string | null;
    matched: boolean;
  };
}

export interface NegotiationResponse {
  negotiationId: string;
  quotationId: string;
  status: string;
  mode: string;
  userNotes: string | null;
  suppliers: NegotiationSupplier[];
  totalTokens?: number;
  totalCostUsd?: number;
  parseMetadata?: ParseMetadata | null;
}

// ─── Context Sections (structured agent input data) ──────────────────────────

export interface ContextSections {
  quotationItems: { sku: string; description: string; qty: number; unitPrice: number; totalPrice: number }[];
  supplierProfile: { name: string; code: string; quality: number; priceLevel: string; leadTime: number; terms: string } | null;
  competitiveIntel: { label: string; totalCost: number; leadTime: number; terms: string; concessions: string[] }[];
  cashFlowSummary: string;
  riskFlags: string[];
  roundStrategy: string;
  userPriorities: string;
}

// ─── Offer Scoring Types ────────────────────────────────────────────────────

export interface OfferScore {
  price: number;
  quality: number;
  leadTime: number;
  cashFlow: number;
  risk: number;
  weighted: number;
}

export interface RoundSupplierScore {
  supplierName: string;
  supplierId: string;
  totalCost: number;
  leadTimeDays: number;
  paymentTerms: string;
  weightedScore: number;
  concessions: string[];
}

export interface RoundAnalysis {
  roundNumber: number;
  summary: string;
  supplierScores: RoundSupplierScore[];
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

// ─── SSE Event Types ─────────────────────────────────────────────────────────

export type SSEEvent =
  | { type: "connected"; negotiationId: string; status: string }
  | { type: "negotiation_started"; negotiationId: string; timestamp: number }
  | { type: "supplier_started"; supplierId: string; supplierName: string; supplierCode: string; quality: number; priceLevel: string; leadTime: number; terms: string; isSimulated?: boolean; timestamp: number }
  | { type: "round_start"; supplierId: string; roundNumber: number; timestamp: number }
  | { type: "supplier_waiting"; supplierId: string; supplierName: string; supplierCode: string; reason: string; roundNumber: number; timestamp: number }
  | { type: "context_built"; supplierId: string; roundNumber: number; summary: string; sections: ContextSections; timestamp: number }
  | { type: "pillar_started"; pillar: string; supplierId: string; roundNumber: number; timestamp: number }
  | { type: "pillar_complete"; pillar: string; supplierId: string; roundNumber: number; output?: string; timestamp: number }
  | {
      type: "message";
      role: "brand_agent" | "supplier_agent";
      supplierId: string;
      supplierName: string;
      content: string;
      roundNumber: number;
      phase?: "initial" | "post_curveball";
      messageId: string;
      timestamp: number;
    }
  | { type: "offer_extracted"; supplierId: string; roundNumber: number; offer: OfferData; timestamp: number }
  | { type: "offers_snapshot"; offers: ScoredOffer[]; timestamp: number }
  | { type: "round_analysis"; roundNumber: number; summary: string; supplierScores: RoundSupplierScore[]; timestamp: number }
  | { type: "round_end"; supplierId: string; roundNumber: number; timestamp: number }
  | { type: "curveball_detected"; supplierId: string; roundNumber: number; description: string; timestamp: number }
  | { type: "curveball_analysis"; analysis: CurveballAnalysis; timestamp: number }
  | { type: "supplier_complete"; supplierId: string; timestamp: number }
  | { type: "negotiation_complete"; negotiationId: string; timestamp: number }
  | { type: "generating_decision"; negotiationId: string; timestamp: number }
  | { type: "decision"; recommendation: FinalRecommendation; comparison: SupplierScore[]; summary: string; keyPoints: KeyPoint[]; reasoning: string; tradeoffs: string; purchaseOrderId: string; allSupplierAllocations?: SupplierAllocation[]; timestamp: number }
  | { type: "error"; message: string; timestamp: number };

// ─── API Functions ───────────────────────────────────────────────────────────

// ─── Local getToken for streaming endpoints ─────────────────────────────────

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("amber_auth_token");
}

export async function parseQuotation(file: File, notes?: string): Promise<ParseResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (notes) formData.append("notes", notes);

  const response = await apiClient.post<ParseResponse>("/parse", formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });

  return response.data;
}

// ─── Load stored parse result by quotationId ─────────────────────────────────

export async function getQuotation(quotationId: string): Promise<ParseResponse> {
  const response = await apiClient.get<ParseResponse>(`/parse/${quotationId}`);
  return response.data;
}

// ─── Confirm user selections (update product matches in DB) ──────────────────

export async function confirmSelections(
  quotationId: string,
  selections: Record<string, string | null>,
): Promise<void> {
  await apiClient.post(`/parse/${quotationId}/confirm`, { selections });
}

// ─── Supplier management ─────────────────────────────────────────────────────

export async function createSupplierForQuotation(
  quotationId: string,
  name: string,
): Promise<SupplierProfile> {
  const response = await apiClient.post<SupplierProfile>(`/parse/${quotationId}/create-supplier`, { name });
  return response.data;
}

export async function updateQuotationSupplier(
  quotationId: string,
  supplierId: string,
): Promise<{ ok: boolean; supplier: SupplierProfile }> {
  const response = await apiClient.put<{ ok: boolean; supplier: SupplierProfile }>(`/parse/${quotationId}/supplier`, { supplierId });
  return response.data;
}

// ─── Start negotiation (POST, returns SSE stream via fetch) ──────────────────

export async function startNegotiation(
  quotationId: string,
  onEvent: (event: SSEEvent) => void,
  options?: { userNotes?: string; mode?: string; maxRounds?: number; signal?: AbortSignal },
): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/negotiate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quotationId,
      userNotes: options?.userNotes,
      mode: options?.mode,
      maxRounds: options?.maxRounds,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Negotiation failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const json = trimmed.slice(6);
        try {
          const event = JSON.parse(json) as SSEEvent;
          onEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}

// ─── Re-quote: start a new negotiation with adjusted quantities ──────────────

export async function startReQuote(
  quotationId: string,
  supplierIds: string[],
  qtyChanges: Record<string, { from: number; to: number }>,
  onEvent: (event: SSEEvent) => void,
  options?: { userNotes?: string; mode?: string; maxRounds?: number; signal?: AbortSignal },
): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/negotiate/requote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      quotationId,
      supplierIds,
      qtyChanges,
      userNotes: options?.userNotes,
      mode: options?.mode,
      maxRounds: options?.maxRounds,
    }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Re-quote failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const json = trimmed.slice(6);
        try {
          const event = JSON.parse(json) as SSEEvent;
          onEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}

// ─── Subscribe to real-time negotiation events via SSE ───────────────────────

export function subscribeToNegotiation(
  negotiationId: string,
  onEvent: (event: SSEEvent) => void,
  options?: { signal?: AbortSignal },
): () => void {
  const token = getToken();
  const url = token
    ? `${API_BASE}/negotiate/${negotiationId}/stream?token=${encodeURIComponent(token)}`
    : `${API_BASE}/negotiate/${negotiationId}/stream`;

  const eventSource = new EventSource(url);

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as SSEEvent;
      onEvent(event);

      // Auto-close when negotiation completes
      if (event.type === "negotiation_complete") {
        eventSource.close();
      }
    } catch {
      // Skip malformed messages
    }
  };

  eventSource.onerror = () => {
    // EventSource auto-reconnects, but if we're aborted, close
    if (options?.signal?.aborted) {
      eventSource.close();
    }
  };

  // Handle abort signal
  if (options?.signal) {
    options.signal.addEventListener("abort", () => {
      eventSource.close();
    });
  }

  // Return cleanup function
  return () => {
    eventSource.close();
  };
}

// ─── Load negotiation state from DB ──────────────────────────────────────────

export async function getNegotiation(negotiationId: string): Promise<NegotiationResponse> {
  const response = await apiClient.get<NegotiationResponse>(`/negotiate/${negotiationId}`);
  return response.data;
}

export async function getNegotiationByQuotation(
  quotationId: string,
): Promise<{ id: string; status: string } | null> {
  try {
    const response = await apiClient.get<{ id: string; status: string }>(
      `/negotiate/by-quotation/${quotationId}`,
    );
    return response.data;
  } catch {
    return null;
  }
}

export async function getDecision(negotiationId: string): Promise<FinalDecisionData | null> {
  try {
    const response = await apiClient.get<FinalDecisionData>(`/negotiate/${negotiationId}/decision`);
    return response.data;
  } catch {
    return null;
  }
}

// ─── Curveball & Decision Types ─────────────────────────────────────────────
// Import from shared package to avoid duplication

export type {
  CurveballStrategy,
  CurveballAnalysis,
  SupplierScore,
  AllocationItem,
  SupplierAllocation,
  FinalRecommendation,
  KeyPoint,
  FinalDecisionData,
} from "@supplier-negotiation/shared";

export type CurveballSSEEvent =
  | { type: "curveball_injected"; description: string }
  | { type: "strategy_proposed"; analysis: CurveballAnalysis }
  | { type: "supplier_started"; supplierId: string; supplierName: string; supplierCode: string }
  | { type: "round_start"; supplierId: string; roundNumber: number }
  | {
      type: "message";
      role: "brand_agent" | "supplier_agent";
      supplierId: string;
      supplierName: string;
      content: string;
      roundNumber: number;
      messageId: string;
    }
  | { type: "offer_extracted"; supplierId: string; roundNumber: number; offer: OfferData }
  | { type: "round_end"; supplierId: string; roundNumber: number }
  | { type: "supplier_complete"; supplierId: string }
  | {
      type: "decision";
      recommendation: FinalRecommendation;
      comparison: SupplierScore[];
      summary?: string;
      keyPoints?: KeyPoint[];
      reasoning: string;
      tradeoffs: string;
      allSupplierAllocations?: SupplierAllocation[];
    }
  | { type: "po_created"; purchaseOrderId: string; status: string }
  | { type: "complete" }
  | { type: "error"; message: string };

// ─── Curveball & PO Functions ───────────────────────────────────────────────

export async function startCurveball(
  negotiationId: string,
  onEvent: (event: CurveballSSEEvent) => void,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const token = getToken();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}/curveball`, {
    method: "POST",
    headers,
    body: JSON.stringify({ negotiationId }),
    signal: options?.signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Curveball failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data: ")) {
        const json = trimmed.slice(6);
        try {
          const event = JSON.parse(json) as CurveballSSEEvent;
          onEvent(event);
        } catch {
          // Skip malformed lines
        }
      }
    }
  }
}

export async function confirmPurchaseOrder(
  purchaseOrderId: string,
): Promise<{ purchaseOrderId: string; status: string }> {
  const response = await apiClient.post<{ purchaseOrderId: string; status: string }>(
    `/purchase-orders/${purchaseOrderId}/confirm`,
    { confirmed: true },
  );
  return response.data;
}

// ─── Authentication API ──────────────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; user: { email: string } }> {
  const response = await apiClient.post<{ token: string; user: { email: string }; expiresIn: string }>(
    "/auth/login",
    { email, password }
  );

  setToken(response.data.token);
  return { token: response.data.token, user: response.data.user };
}

export function logout(): void {
  removeToken();
  if (typeof window !== "undefined") {
    window.location.href = "/login";
  }
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

export async function getCurrentUser(): Promise<{ email: string } | null> {
  try {
    const response = await apiClient.get<{ user: { email: string } }>("/auth/me");
    return response.data.user;
  } catch (error) {
    return null;
  }
}
