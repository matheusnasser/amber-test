"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  startNegotiation,
  startReQuote,
  getNegotiationByQuotation,
  getDecision,
} from "@/services/api-client";
import type {
  SSEEvent,
  OfferData,
  ScoredOffer,
  FinalDecisionData,
  GroupedProduct,
  RoundAnalysis,
  CurveballAnalysis,
} from "@/services/api-client";
import type { SupplierProgress } from "./WorkflowSidebar";
import { calculateCashFlowCost } from "@/lib/formatting";

// ─── Types ──────────────────────────────────────────────────────────────────

interface SupplierState {
  supplierId: string;
  supplierName: string;
  supplierCode: string;
  isSimulated: boolean;
  messages: Array<{
    id: string;
    role: "brand_agent" | "supplier_agent";
    content: string;
    roundNumber: number;
    phase?: "initial" | "post_curveball";
  }>;
  rounds: Array<{
    roundNumber: number;
    offer: OfferData | null;
  }>;
  status: "waiting" | "negotiating" | "complete";
  currentRound: number;
}

export interface PillarActivity {
  pillar: string;
  supplierId: string;
  supplierName: string;
  roundNumber: number;
  status: "active" | "complete";
  output?: string;
}

interface NegotiationPanelProps {
  quotationId: string;
  maxRounds?: number;
  userNotes?: string;
  products?: GroupedProduct[];
  onComplete?: (negotiationId: string) => void;
  onDecision?: (decision: FinalDecisionData) => void;
  onProgressUpdate?: (progress: Map<string, SupplierProgress>) => void;
  onPillarUpdate?: (pillars: PillarActivity[]) => void;
  reQuoteParams?: { supplierIds: string[]; qtyChanges: Record<string, { from: number; to: number }> } | null;
  showFlow?: boolean;
  onToggleFlow?: () => void;
}

// ─── Format helpers ─────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function getEffectiveCost(offer: { totalCost: number; paymentTerms: string; leadTimeDays: number }): number {
  return offer.totalCost + calculateCashFlowCost(offer.totalCost, offer.paymentTerms, offer.leadTimeDays);
}

// ─── Strategy insight generator ─────────────────────────────────────────────

function generateInsight(suppliers: SupplierState[]): string | null {
  const completed = suppliers.filter((s) => s.status === "complete");
  const negotiating = suppliers.find((s) => s.status === "negotiating");

  if (completed.length === 0 && !negotiating) return null;

  const getLatestOffer = (s: SupplierState) =>
    s.rounds
      .filter((r) => r.offer)
      .sort((a, b) => b.roundNumber - a.roundNumber)[0]?.offer ?? null;

  const offersWithNames = suppliers
    .map((s) => ({ name: s.supplierName, offer: getLatestOffer(s) }))
    .filter((o) => o.offer !== null) as Array<{ name: string; offer: OfferData }>;

  if (offersWithNames.length === 0) {
    if (negotiating) return `Starting negotiations with ${negotiating.supplierName}...`;
    return null;
  }

  const withEffective = offersWithNames.map((o) => ({
    ...o,
    effective: getEffectiveCost(o.offer),
  }));
  const bestEffective = withEffective.reduce((a, b) => a.effective < b.effective ? a : b);
  const fastest = offersWithNames.reduce((a, b) =>
    a.offer.leadTimeDays < b.offer.leadTimeDays ? a : b,
  );

  if (negotiating) {
    const parts: string[] = [];
    parts.push(`${bestEffective.name} leads at ${formatCurrency(bestEffective.effective)} effective.`);
    if (fastest.name !== bestEffective.name) {
      parts.push(`${fastest.name} is fastest at ${fastest.offer.leadTimeDays}d.`);
    }
    parts.push(`Now negotiating with ${negotiating.supplierName} — use this as leverage.`);
    return parts.join(" ");
  }

  if (completed.length === suppliers.length) {
    const costSpread = Math.max(...withEffective.map((o) => o.effective)) -
      Math.min(...withEffective.map((o) => o.effective));
    return `All negotiations complete. ${bestEffective.name} best effective cost at ${formatCurrency(bestEffective.effective)}. Spread: ${formatCurrency(costSpread)}.`;
  }

  return `${bestEffective.name} leads at ${formatCurrency(bestEffective.effective)} effective.`;
}

// ─── Message content renderer (tables for product lists) ────────────────────

function cleanMessageText(raw: string): string {
  let text = raw;
  // Strip email-style subject lines: "**Subject: ...**\n" or "Subject: ...\n"
  text = text.replace(/^\*{0,2}(?:Subject|RE|Re|FW|Fw):\s*.*?\*{0,2}\s*\n?/gm, "");
  // Strip markdown bold markers
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  // Strip leading/trailing whitespace that remains
  text = text.replace(/^\s*\n/, "").trim();
  return text;
}

function renderMessageContent(content: string, isBrand: boolean) {
  const cleaned = cleanMessageText(content);
  // Detect product list patterns: "- SKU: $XX.XX x NNN" or "- SKU-CODE: description"
  const lines = cleaned.split("\n");
  const segments: { type: "text" | "table"; lines: string[] }[] = [];
  let current: { type: "text" | "table"; lines: string[] } = { type: "text", lines: [] };

  const isProductLine = (line: string) =>
    /^\s*[-•]\s+\w{2,}[\w-]*.*\$[\d,.]+/.test(line) ||
    /^\s*[-•]\s+\w{2,}[\w-]*.*x\s*\d+/.test(line);

  for (const line of lines) {
    if (isProductLine(line)) {
      if (current.type !== "table") {
        if (current.lines.length > 0) segments.push(current);
        current = { type: "table", lines: [] };
      }
      current.lines.push(line);
    } else {
      if (current.type !== "text") {
        if (current.lines.length > 0) segments.push(current);
        current = { type: "text", lines: [] };
      }
      current.lines.push(line);
    }
  }
  if (current.lines.length > 0) segments.push(current);

  return segments.map((seg, i) => {
    if (seg.type === "table" && seg.lines.length > 2) {
      // Parse product lines into table rows
      const rows = seg.lines.map((line) => {
        const cleaned = line.replace(/^\s*[-•]\s+/, "");
        // Try "SKU: $price x qty" or "SKU: description | qty | $price"
        const match = cleaned.match(/^([\w-]+)[:\s]+(.*)$/);
        if (match) return { sku: match[1], detail: match[2] };
        return { sku: cleaned, detail: "" };
      });
      const textColor = isBrand ? "text-white/70" : "text-gray-500";
      const borderColor = isBrand ? "border-white/10" : "border-gray-200";
      return (
        <table key={i} className={`w-full text-xs border-collapse my-1.5 ${textColor}`}>
          <tbody>
            {rows.map((row, j) => (
              <tr key={j} className={`border-b ${borderColor}`}>
                <td className="py-0.5 pr-2 font-mono text-[11px] whitespace-nowrap">{row.sku}</td>
                <td className="py-0.5 text-[11px]">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    return (
      <span key={i} className="whitespace-pre-wrap">{seg.lines.join("\n")}</span>
    );
  });
}

// ─── Message bubble ─────────────────────────────────────────────────────────

function MessageBubble({
  role,
  content,
  supplierName,
}: {
  role: "brand_agent" | "supplier_agent";
  content: string;
  supplierName: string;
}) {
  const isBrand = role === "brand_agent";
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 600;
  const displayContent = isLong && !expanded ? content.slice(0, 500) + "..." : content;

  return (
    <div className={`flex ${isBrand ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-lg px-4 py-3 ${
        isBrand
          ? "bg-gray-900 text-white"
          : "bg-gray-100 text-gray-900"
      }`}>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider opacity-50">
          {isBrand ? "Brand Agent" : supplierName}
        </div>
        <div className="text-sm leading-relaxed">
          {renderMessageContent(displayContent, isBrand)}
        </div>
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className={`mt-1 text-[10px] font-medium ${isBrand ? "text-blue-300 hover:text-blue-200" : "text-blue-600 hover:text-blue-500"}`}
          >
            {expanded ? "Show less" : "Show full message"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Offer card ─────────────────────────────────────────────────────────────

function OfferCard({ offer, roundNumber, products }: { offer: OfferData; roundNumber: number; products?: GroupedProduct[] }) {
  const [showItems, setShowItems] = useState(false);

  // Build a lookup from SKU → baseline tiers
  const tiersBySku = products
    ? new Map(products.filter((p) => p.tiers.length > 0).map((p) => [p.rawSku.toUpperCase().trim(), p]))
    : null;

  return (
    <div className="mx-4 rounded-md border border-gray-200 bg-gray-50/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          Round {roundNumber} Offer
        </span>
        <span className="text-sm font-semibold text-gray-900">
          {formatCurrency(offer.totalCost)}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        <span>Lead: <span className="font-medium text-gray-700">{offer.leadTimeDays}d</span></span>
        <span>Terms: <span className="font-medium text-gray-700">{offer.paymentTerms}</span></span>
        {offer.items.length > 0 && (
          <button
            onClick={() => setShowItems(!showItems)}
            className="text-blue-600 hover:text-blue-500 font-medium"
          >
            {showItems ? "Hide" : "Show"} {offer.items.length} items
          </button>
        )}
      </div>
      {offer.concessions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {offer.concessions.map((c, i) => (
            <span key={i} className="rounded-full bg-white border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600">
              {c}
            </span>
          ))}
        </div>
      )}
      {showItems && offer.items.length > 0 && (
        <table className="mt-2 w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-1 px-1 font-medium text-gray-400">SKU</th>
              <th className="text-right py-1 px-1 font-medium text-gray-400">Unit $</th>
              <th className="text-right py-1 px-1 font-medium text-gray-400">Qty</th>
              <th className="text-right py-1 px-1 font-medium text-gray-400">Total</th>
              {tiersBySku && <th className="text-right py-1 px-1 font-medium text-gray-400">Baseline</th>}
            </tr>
          </thead>
          <tbody>
            {offer.items.map((item, i) => {
              const baseline = tiersBySku?.get(item.sku.toUpperCase().trim());
              const baselineTiers = baseline?.tiers ?? [];
              const primaryTier = baselineTiers[0];
              const delta = primaryTier?.rawUnitPrice != null
                ? item.unitPrice - primaryTier.rawUnitPrice
                : null;

              return (
                <tr key={i} className="border-b border-gray-100 group">
                  <td className="py-0.5 px-1 font-mono text-gray-700">{item.sku}</td>
                  <td className="text-right py-0.5 px-1 text-gray-600">${item.unitPrice.toFixed(2)}</td>
                  <td className="text-right py-0.5 px-1 text-gray-600">{item.quantity}</td>
                  <td className="text-right py-0.5 px-1 text-gray-800 font-medium">
                    ${(item.unitPrice * item.quantity).toLocaleString()}
                  </td>
                  {tiersBySku && (
                    <td className="text-right py-0.5 px-1">
                      {primaryTier?.rawUnitPrice != null ? (
                        <span className="flex items-center justify-end gap-1">
                          <span className="text-gray-400">${primaryTier.rawUnitPrice.toFixed(2)}</span>
                          {delta !== null && Math.abs(delta) >= 0.01 && (
                            <span className={`text-[9px] font-medium ${delta < 0 ? "text-emerald-600" : "text-red-500"}`}>
                              {delta < 0 ? "↓" : "↑"}{Math.abs(((delta / primaryTier.rawUnitPrice) * 100)).toFixed(0)}%
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Supplier chat ──────────────────────────────────────────────────────────

function SupplierChat({ supplier, fullWidth, products }: { supplier: SupplierState; fullWidth?: boolean; products?: GroupedProduct[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [supplier.messages.length]);

  const latestOffer = supplier.rounds
    .filter((r) => r.offer)
    .sort((a, b) => b.roundNumber - a.roundNumber)[0]?.offer;

  return (
    <div className={`flex flex-col rounded-lg border border-gray-200 bg-white ${fullWidth ? "min-h-[500px]" : "h-full"}`}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${
            supplier.status === "negotiating" ? "bg-amber-400 animate-pulse" :
            supplier.status === "complete" ? "bg-gray-800" : "bg-gray-300"
          }`} />
          <span className="text-sm font-semibold text-gray-800">
            {supplier.supplierName}
          </span>
          {supplier.isSimulated ? (
            <span className="rounded-full bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[9px] font-medium text-blue-600">
              Simulated
            </span>
          ) : (
            <span className="rounded-full bg-gray-100 border border-gray-200 px-1.5 py-0.5 text-[9px] font-medium text-gray-500">
              XLSX Source
            </span>
          )}
          <span className="text-xs text-gray-400 font-mono">
            {supplier.supplierCode}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {supplier.currentRound > 0 && (
            <span className="text-xs text-gray-400 font-mono tabular-nums">
              R{supplier.currentRound}
            </span>
          )}
          {latestOffer && (
            <span className="text-sm font-medium text-gray-700">
              {formatCurrency(latestOffer.totalCost)}
            </span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={{ maxHeight: fullWidth ? "500px" : "600px" }}>
        {supplier.status === "waiting" && supplier.messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            Waiting to start...
          </div>
        )}

        {supplier.messages.map((msg, idx) => {
          const prevMsg = idx > 0 ? supplier.messages[idx - 1] : null;
          const phaseChanged = prevMsg && msg.phase !== prevMsg.phase && msg.phase === "post_curveball";
          const roundChanged = prevMsg && msg.roundNumber !== prevMsg.roundNumber && !phaseChanged;

          const offerForRound = msg.role === "supplier_agent"
            ? supplier.rounds.find((r) => r.roundNumber === msg.roundNumber && r.offer)
            : null;

          return (
            <div key={msg.id || idx}>
              {/* Phase divider: initial → post_curveball */}
              {phaseChanged && (
                <div className="flex items-center gap-3 py-4">
                  <div className="flex-1 border-t border-amber-300" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500 whitespace-nowrap flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    Post-Curveball Renegotiation
                  </span>
                  <div className="flex-1 border-t border-amber-300" />
                </div>
              )}

              {/* Round divider within same phase */}
              {roundChanged && (
                <div className="flex items-center gap-2 py-2">
                  <div className="flex-1 border-t border-gray-100" />
                  <span className="text-[9px] text-gray-300 font-mono">Round {msg.roundNumber}</span>
                  <div className="flex-1 border-t border-gray-100" />
                </div>
              )}

              <MessageBubble
                role={msg.role}
                content={msg.content}
                supplierName={supplier.supplierName}
              />
              {offerForRound?.offer && (
                <div className="mt-2">
                  <OfferCard offer={offerForRound.offer} roundNumber={offerForRound.roundNumber} products={products} />
                </div>
              )}
            </div>
          );
        })}

        {supplier.status === "waiting" && (
          <div className="flex justify-center py-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex items-center gap-2 text-xs text-amber-600 font-medium">
                <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                Gathering competitive quotes...
              </div>
              <p className="text-[10px] text-gray-400 max-w-[280px]">
                Quoting other suppliers first to build negotiation leverage for this supplier.
              </p>
            </div>
          </div>
        )}

        {supplier.status === "negotiating" && (
          <div className="flex justify-center">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <div className="h-1.5 w-1.5 rounded-full bg-gray-300 animate-pulse" />
              Negotiating...
            </div>
          </div>
        )}

      </div>

      {/* Footer with latest offer summary */}
      {supplier.status === "complete" && latestOffer && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/50">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Final offer</span>
            <div className="flex gap-3">
              <span>Lead: <span className="font-medium text-gray-700">{latestOffer.leadTimeDays}d</span></span>
              <span>Terms: <span className="font-medium text-gray-700">{latestOffer.paymentTerms}</span></span>
              <span className="font-semibold text-gray-900">{formatCurrency(latestOffer.totalCost)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Supplier Detail Sidebar ─────────────────────────────────────────────────

function SupplierDetailSidebar({
  supplier,
  products,
  scoredSnapshots,
  onClose,
}: {
  supplier: SupplierState;
  products?: GroupedProduct[];
  scoredSnapshots: ScoredOffer[][];
  onClose: () => void;
}) {
  const [showAllTiers, setShowAllTiers] = useState(false);
  const [showAllProducts, setShowAllProducts] = useState(false);

  // Get all rounds with offers for this supplier
  const roundsWithOffers = supplier.rounds
    .filter((r) => r.offer)
    .sort((a, b) => a.roundNumber - b.roundNumber);

  // Pricing tiers — only relevant for S1 (XLSX source)
  const hasTiers = products && products.some((p) => p.tiers.length > 1);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-[420px] max-w-full bg-white border-l border-gray-200 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-gray-900">{supplier.supplierName}</h3>
            <span className="text-[10px] font-mono text-gray-400">{supplier.supplierCode}</span>
            {!supplier.isSimulated && (
              <span className="rounded-full bg-gray-100 border border-gray-200 px-1.5 py-0.5 text-[8px] font-medium text-gray-400">XLSX</span>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-0.5">
            {supplier.supplierCode === "SUP-001" ? "Quality 4.0 · 50d lead · 33/33/33" :
             supplier.supplierCode === "SUP-002" ? "Quality 4.7 · 25d lead · 40/60" :
             supplier.supplierCode === "SUP-003" ? "Quality 4.0 · 15d lead · 100% upfront" :
             ""}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Offer evolution */}
        {roundsWithOffers.length > 0 && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Offer History
            </span>
            <div className="mt-2 space-y-2">
              {roundsWithOffers.map((round, idx) => {
                const offer = round.offer!;
                const prev = idx > 0 ? roundsWithOffers[idx - 1].offer! : null;
                const costDelta = prev ? offer.totalCost - prev.totalCost : null;
                const leadDelta = prev ? offer.leadTimeDays - prev.leadTimeDays : null;

                return (
                  <div key={round.roundNumber} className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-700">R{round.roundNumber}</span>
                        {idx === 0 && !supplier.isSimulated && (
                          <span className="text-[8px] font-medium bg-amber-100 text-amber-700 px-1 py-0.5 rounded">XLSX</span>
                        )}
                      </div>
                      <span className="text-sm font-bold text-gray-900 tabular-nums">
                        {formatCurrency(offer.totalCost)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-gray-500">
                      <span>{offer.leadTimeDays}d lead</span>
                      <span>{offer.paymentTerms}</span>
                      {offer.concessions.length > 0 && (
                        <span className="text-emerald-600">{offer.concessions.length} concession{offer.concessions.length > 1 ? "s" : ""}</span>
                      )}
                    </div>
                    {/* Deltas */}
                    {prev && (costDelta !== 0 || (leadDelta !== null && leadDelta !== 0)) && (
                      <div className="flex gap-2 mt-1.5">
                        {costDelta !== null && costDelta !== 0 && (
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            costDelta < 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}>
                            {costDelta < 0 ? "↓" : "↑"}{formatCurrency(Math.abs(costDelta))}
                          </span>
                        )}
                        {leadDelta !== null && leadDelta !== 0 && (
                          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                            leadDelta < 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}>
                            {leadDelta < 0 ? "↓" : "↑"}{Math.abs(leadDelta)}d
                          </span>
                        )}
                      </div>
                    )}
                    {/* Concessions list */}
                    {offer.concessions.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {offer.concessions.map((c, ci) => (
                          <span key={ci} className="text-[9px] bg-white border border-gray-200 text-gray-500 px-1.5 py-0.5 rounded">
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pricing tiers from XLSX */}
        {hasTiers && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              XLSX Pricing Tiers
            </span>
            <p className="text-[10px] text-gray-400 mt-0.5 mb-2">
              {products!.filter((p) => p.tiers.length > 1).length} products with multiple tiers
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-400">
                    <th className="py-1.5 pr-2 font-medium">SKU</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Qty</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Unit</th>
                    <th className="py-1.5 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const tieredProducts = products!.filter((p) => p.tiers.length > 1);
                    const visible = showAllTiers ? tieredProducts : tieredProducts.slice(0, 10);
                    return visible.map((product) => (
                      product.tiers.map((tier, ti) => (
                        <tr
                          key={`${product.rawSku}-${ti}`}
                          className={`border-b border-gray-50 ${ti === 0 ? "" : "text-gray-400"}`}
                        >
                          <td className="py-1 pr-2 text-gray-700">
                            {ti === 0 ? product.rawSku : ""}
                          </td>
                          <td className="py-1 pr-2 text-right tabular-nums">
                            {tier.rawQuantity?.toLocaleString() ?? "—"}
                          </td>
                          <td className="py-1 pr-2 text-right tabular-nums">
                            {tier.rawUnitPrice != null ? `$${tier.rawUnitPrice.toFixed(2)}` : "—"}
                          </td>
                          <td className="py-1 text-right tabular-nums font-medium">
                            {tier.rawTotalPrice != null ? `$${tier.rawTotalPrice.toLocaleString()}` : "—"}
                          </td>
                        </tr>
                      ))
                    ));
                  })()}
                </tbody>
              </table>
              {products!.filter((p) => p.tiers.length > 1).length > 10 && (
                <button
                  onClick={() => setShowAllTiers(!showAllTiers)}
                  className="w-full text-[10px] text-blue-600 hover:text-blue-800 font-medium mt-1.5 text-center py-1 hover:bg-blue-50 rounded transition-colors"
                >
                  {showAllTiers
                    ? "Show less"
                    : `Show all ${products!.filter((p) => p.tiers.length > 1).length} products`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* All products (single tier) */}
        {products && products.length > 0 && !hasTiers && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Quotation Items ({products.length})
            </span>
            <div className="overflow-x-auto mt-2">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-gray-400">
                    <th className="py-1.5 pr-2 font-medium">SKU</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Qty</th>
                    <th className="py-1.5 pr-2 font-medium text-right">Unit</th>
                    <th className="py-1.5 font-medium text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAllProducts ? products : products.slice(0, 15)).map((product) => {
                    const tier = product.tiers[0];
                    return (
                      <tr key={product.rawSku} className="border-b border-gray-50">
                        <td className="py-1 pr-2 text-gray-700">{product.rawSku}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{tier?.rawQuantity?.toLocaleString() ?? "—"}</td>
                        <td className="py-1 pr-2 text-right tabular-nums">{tier?.rawUnitPrice != null ? `$${tier.rawUnitPrice.toFixed(2)}` : "—"}</td>
                        <td className="py-1 text-right tabular-nums font-medium">{tier?.rawTotalPrice != null ? `$${tier.rawTotalPrice.toLocaleString()}` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {products.length > 15 && (
                <button
                  onClick={() => setShowAllProducts(!showAllProducts)}
                  className="w-full text-[10px] text-blue-600 hover:text-blue-800 font-medium mt-1.5 text-center py-1 hover:bg-blue-50 rounded transition-colors"
                >
                  {showAllProducts ? "Show less" : `Show all ${products.length} products`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-gray-200 px-5 py-3 bg-gray-50/50">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>{supplier.status === "complete" ? "Complete" : supplier.status === "negotiating" ? "In progress" : "Waiting"}</span>
          <span className="tabular-nums">
            {roundsWithOffers.length > 0
              ? `${roundsWithOffers.length} round${roundsWithOffers.length > 1 ? "s" : ""} · Latest: ${formatCurrency(roundsWithOffers[roundsWithOffers.length - 1].offer!.totalCost)}`
              : "No offers yet"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Round Analysis Slideshow ────────────────────────────────────────────────

function RoundAnalysisSlideshow({ analyses }: { analyses: RoundAnalysis[] }) {
  const [currentIdx, setCurrentIdx] = useState(analyses.length - 1);

  // Auto-advance to latest when new rounds come in
  useEffect(() => {
    setCurrentIdx(analyses.length - 1);
  }, [analyses.length]);

  if (analyses.length === 0) return null;

  const current = analyses[Math.min(currentIdx, analyses.length - 1)];
  if (!current) return null;

  const sorted = [...current.supplierScores].sort((a, b) => b.weightedScore - a.weightedScore);
  const best = sorted[0];

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Header with nav */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 bg-gray-50/50">
        <button
          onClick={() => setCurrentIdx(Math.max(0, currentIdx - 1))}
          disabled={currentIdx === 0}
          className="rounded p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          {analyses.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setCurrentIdx(idx)}
              className={`h-1.5 rounded-full transition-all ${
                idx === currentIdx ? "w-4 bg-gray-800" : "w-1.5 bg-gray-300 hover:bg-gray-400"
              }`}
              title={`Round ${idx + 1}`}
            />
          ))}
        </div>
        <button
          onClick={() => setCurrentIdx(Math.min(analyses.length - 1, currentIdx + 1))}
          disabled={currentIdx >= analyses.length - 1}
          className="rounded p-1 text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Round content */}
      <div className="p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
            Round {current.roundNumber}
          </span>
          {best && (
            <span className="text-[10px] font-semibold text-gray-600">
              Leading: {best.supplierName} ({best.weightedScore}/100)
            </span>
          )}
        </div>

        {/* Supplier cards */}
        <div className="space-y-1.5">
          {sorted.map((s, idx) => (
            <div
              key={s.supplierId}
              className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-xs ${
                idx === 0 ? "bg-gray-900 text-white" : "bg-gray-50 text-gray-600"
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className={`font-semibold ${idx === 0 ? "text-white" : "text-gray-800"}`}>
                  {s.supplierName}
                </span>
                {s.concessions.length > 0 && (
                  <span className={`text-[9px] truncate max-w-[120px] ${idx === 0 ? "text-gray-300" : "text-gray-400"}`}>
                    {s.concessions[s.concessions.length - 1]}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 tabular-nums">
                <span className={`${idx === 0 ? "text-gray-300" : "text-gray-400"}`}>
                  ${(s.totalCost / 1000).toFixed(1)}k
                </span>
                <span className={`${idx === 0 ? "text-gray-300" : "text-gray-400"}`}>
                  {s.leadTimeDays}d
                </span>
                <span className={`font-bold ${idx === 0 ? "text-white" : "text-gray-700"}`}>
                  {s.weightedScore}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Comparison Dashboard ───────────────────────────────────────────────────

function ComparisonDashboard({
  suppliers,
  onToggle,
  onDetailClick,
}: {
  suppliers: SupplierState[];
  onToggle: (id: string) => void;
  onDetailClick: (id: string) => void;
}) {
  const getLatestOffer = (s: SupplierState) =>
    s.rounds
      .filter((r) => r.offer)
      .sort((a, b) => b.roundNumber - a.roundNumber)[0]?.offer ?? null;

  const offers = suppliers
    .map((s) => ({ supplier: s, offer: getLatestOffer(s) }))
    .filter((o) => o.offer !== null) as Array<{ supplier: SupplierState; offer: OfferData }>;

  const effectiveCosts = offers.map((o) => ({ ...o, effective: getEffectiveCost(o.offer) }));
  const bestEffective = effectiveCosts.length > 0 ? Math.min(...effectiveCosts.map((o) => o.effective)) : null;
  const worstEffective = effectiveCosts.length > 0 ? Math.max(...effectiveCosts.map((o) => o.effective)) : null;
  const allSameEffective = bestEffective !== null && worstEffective !== null && Math.abs(worstEffective - bestEffective) < 1;
  const fastestLead = offers.length > 0 ? Math.min(...offers.map((o) => o.offer.leadTimeDays)) : null;

  return (
    <div className="grid grid-cols-3 gap-3">
      {suppliers.map((supplier) => {
        const offer = getLatestOffer(supplier);
        const effectiveCost = offer ? getEffectiveCost(offer) : null;
        const isBestEffective = effectiveCost !== null && bestEffective !== null && Math.abs(effectiveCost - bestEffective) < 1 && !allSameEffective;
        const isFastestLead = offer && fastestLead !== null && offer.leadTimeDays === fastestLead;

        return (
          <div
            key={supplier.supplierId}
            onClick={() => onToggle(supplier.supplierId)}
            className="rounded-lg border border-gray-200 bg-white p-3 text-left transition-all hover:border-gray-300 hover:bg-gray-50 cursor-pointer"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${
                  supplier.status === "negotiating" ? "bg-amber-400 animate-pulse" :
                  supplier.status === "complete" ? "bg-gray-800" : "bg-gray-300"
                }`} />
                <span className="text-xs font-semibold text-gray-700">{supplier.supplierName}</span>
                {supplier.isSimulated ? (
                  <span className="rounded-full bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[9px] font-medium text-blue-600">
                    Simulated
                  </span>
                ) : (
                  <span className="rounded-full bg-gray-100 border border-gray-200 px-1.5 py-0.5 text-[9px] font-medium text-gray-500">
                    XLSX Source
                  </span>
                )}
              </div>
              <span className="text-[10px] text-gray-400 font-mono">{supplier.supplierCode}</span>
            </div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-[10px] text-gray-400 flex-1">
                {supplier.supplierCode === "SUP-001" ? "4.0q · 50d lead · 33/33/33" :
                 supplier.supplierCode === "SUP-002" ? "4.7q · 25d lead · 40/60" :
                 supplier.supplierCode === "SUP-003" ? "4.0q · 15d lead · 100% upfront" :
                 supplier.supplierCode}
              </p>
              <button
                onClick={(e) => { e.stopPropagation(); onDetailClick(supplier.supplierId); }}
                className="rounded p-1 text-gray-300 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                title="View details"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>

            {offer && effectiveCost !== null ? (
              <>
                <div className="mb-2 space-y-0.5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-lg font-bold tabular-nums text-gray-900">
                      {formatCurrency(offer.totalCost)}
                    </span>
                    <span className="text-[10px] text-gray-400">FOB</span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className={`text-sm font-semibold tabular-nums ${isBestEffective ? "text-emerald-600" : "text-gray-600"}`}>
                      {formatCurrency(effectiveCost)}
                    </span>
                    <span className="text-[10px] text-gray-400">effective</span>
                    {isBestEffective && offers.length > 1 && (
                      <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                        Best
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-1 text-xs text-gray-500">
                  <div className="flex justify-between">
                    <span>Lead time</span>
                    <span className={`font-medium ${isFastestLead && offers.length > 1 ? "text-emerald-600" : "text-gray-700"}`}>
                      {offer.leadTimeDays}d{isFastestLead && offers.length > 1 ? " (fastest)" : ""}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Terms</span>
                    <span className="font-medium text-gray-700">{offer.paymentTerms}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Concessions</span>
                    <span className="font-medium text-gray-700">{offer.concessions.length}</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="py-3 text-center text-xs text-gray-400 italic">
                {supplier.status === "waiting"
                  ? "Waiting..."
                  : !supplier.isSimulated && supplier.currentRound <= 1 && supplier.messages.length > 0
                    ? "XLSX offer — waiting for others"
                    : "Negotiating..."}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Supplier Row (highlights mode) ──────────────────────────────────────────

function SupplierRow({
  supplier,
  expanded,
  onToggle,
  products,
}: {
  supplier: SupplierState;
  expanded: boolean;
  onToggle: () => void;
  products?: GroupedProduct[];
}) {
  const latestOffer = supplier.rounds
    .filter((r) => r.offer)
    .sort((a, b) => b.roundNumber - a.roundNumber)[0]?.offer ?? null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Clickable summary row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
          supplier.status === "negotiating" ? "bg-amber-400 animate-pulse" :
          supplier.status === "complete" ? "bg-gray-800" : "bg-gray-300"
        }`} />
        <span className="text-sm font-semibold text-gray-800 min-w-[140px]">
          {supplier.supplierName}
        </span>
        <span className="text-xs text-gray-400 font-mono">
          {supplier.supplierCode}
        </span>

        {latestOffer ? (
          <div className="flex items-center gap-4 ml-auto text-xs text-gray-500 tabular-nums">
            <span>R{supplier.currentRound}</span>
            <span className="font-semibold text-gray-800">{formatCurrency(latestOffer.totalCost)}</span>
            <span>{latestOffer.leadTimeDays}d lead</span>
            <span>{latestOffer.paymentTerms}</span>
            {latestOffer.concessions.length > 0 && (
              <span className="text-emerald-600">{latestOffer.concessions.length} concession{latestOffer.concessions.length > 1 ? "s" : ""}</span>
            )}
          </div>
        ) : (
          <div className="ml-auto text-xs text-gray-400 italic">
            {supplier.status === "waiting" ? "Waiting..." : "Negotiating..."}
          </div>
        )}

        <svg
          className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expandable chat */}
      {expanded && (
        <div className="border-t border-gray-100">
          <SupplierChat supplier={supplier} fullWidth products={products} />
        </div>
      )}
    </div>
  );
}

// ─── Curveball Banner ─────────────────────────────────────────────────────────

function CurveballBanner({
  description,
  analysis,
  isRenegotiating,
}: {
  description: string;
  analysis?: CurveballAnalysis;
  isRenegotiating: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <svg className="w-5 h-5 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-amber-800">Mid-Negotiation Disruption</h4>
          <p className="mt-1 text-sm text-amber-700">{description}</p>

          {!analysis && (
            <div className="mt-3 flex items-center gap-2">
              <div className="h-3.5 w-3.5 rounded-full border-2 border-amber-300 border-t-amber-600 animate-spin" />
              <span className="text-xs text-amber-600">Analyzing impact and generating strategies...</span>
            </div>
          )}

          {analysis && (
            <div className="mt-3 space-y-2">
              <div className="rounded-md bg-white/60 border border-amber-100 px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">Impact</span>
                <p className="text-xs text-amber-800 mt-0.5">{analysis.impact}</p>
              </div>
              <div className="rounded-md bg-white/60 border border-amber-100 px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-500">Recommendation</span>
                <p className="text-xs text-amber-800 mt-0.5">{analysis.recommendation}</p>
              </div>
            </div>
          )}

          {isRenegotiating && analysis && (
            <div className="mt-3 flex items-center gap-2">
              <div className="h-3.5 w-3.5 rounded-full border-2 border-amber-300 border-t-amber-600 animate-spin" />
              <span className="text-xs text-amber-600">Renegotiating with adjusted strategy...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

export function NegotiationPanel({ quotationId, maxRounds, userNotes, products, onComplete, onDecision, onProgressUpdate, onPillarUpdate, reQuoteParams, showFlow = false, onToggleFlow }: NegotiationPanelProps) {
  const [suppliers, setSuppliers] = useState<SupplierState[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "negotiating" | "generating_decision" | "complete" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [negotiationId, setNegotiationId] = useState<string | null>(null);
  const [expandedChats, setExpandedChats] = useState<Set<string>>(new Set());
  const [scoredSnapshots, setScoredSnapshots] = useState<ScoredOffer[][]>([]);
  const [roundAnalyses, setRoundAnalyses] = useState<RoundAnalysis[]>([]);
  const [detailSupplierId, setDetailSupplierId] = useState<string | null>(null);
  const [pillarActivities, setPillarActivities] = useState<PillarActivity[]>([]);
  const [curveballInfo, setCurveballInfo] = useState<{
    description: string;
    analysis?: CurveballAnalysis;
  } | null>(null);
  const [showFlowTooltip, setShowFlowTooltip] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("");
  const [retryCount, setRetryCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Use refs for callbacks to avoid re-creating useCallback/useEffect chains
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const onDecisionRef = useRef(onDecision);
  onDecisionRef.current = onDecision;

  const onProgressUpdateRef = useRef(onProgressUpdate);
  onProgressUpdateRef.current = onProgressUpdate;

  const onPillarUpdateRef = useRef(onPillarUpdate);
  onPillarUpdateRef.current = onPillarUpdate;

  // Push progress to parent — deferred via queueMicrotask to avoid setState-during-render
  const pushProgress = useCallback((supplierList: SupplierState[]) => {
    if (!onProgressUpdateRef.current) return;
    const progress = new Map<string, SupplierProgress>();
    for (const s of supplierList) {
      progress.set(s.supplierId, {
        name: s.supplierName,
        currentRound: s.currentRound,
        totalRounds: 5, // MAX_ROUNDS_PER_SUPPLIER
        complete: s.status === "complete",
      });
    }
    // Defer to avoid "Cannot update component while rendering another"
    queueMicrotask(() => onProgressUpdateRef.current?.(progress));
  }, []);

  // No loadExisting — always start fresh (backend deletes old negotiation if any)

  // Shared SSE event handler — used by both startNew and re-quote
  const handleSSEEvent = useCallback((event: SSEEvent) => {
    switch (event.type) {
      case "negotiation_started":
        setNegotiationId(event.negotiationId);
        setShowFlowTooltip(true);
        setTimeout(() => setShowFlowTooltip(false), 5000); // Auto-hide after 5s
        break;

          case "supplier_started":
            setSuppliers((prev) => {
              // Prevent duplicates — only add if this supplier doesn't exist yet
              const exists = prev.find((s) => s.supplierId === event.supplierId);
              if (exists) {
                // Supplier already exists — just update status to negotiating
                const next = prev.map((s) =>
                  s.supplierId === event.supplierId
                    ? { ...s, status: "negotiating" as const }
                    : s
                );
                pushProgress(next);
                return next;
              }

              // Ensure only ONE XLSX source supplier (non-simulated)
              const hasXlsxSource = prev.some((s) => !s.isSimulated);
              const isXlsxSource = !(event.isSimulated ?? false);
              
              if (isXlsxSource && hasXlsxSource) {
                console.warn("Attempted to add second XLSX source supplier, ignoring");
                return prev;
              }

              // New supplier — add it
              const newSupplier = {
                supplierId: event.supplierId,
                supplierName: event.supplierName,
                supplierCode: event.supplierCode,
                isSimulated: event.isSimulated ?? false,
                messages: [],
                rounds: [],
                status: "negotiating" as const,
                currentRound: 0,
              };

              // XLSX source supplier (non-simulated) always comes first
              const next = newSupplier.isSimulated
                ? [...prev, newSupplier]
                : [newSupplier, ...prev];

              pushProgress(next);
              return next;
            });
            break;

          case "supplier_waiting":
            setSuppliers((prev) => {
              const next = prev.map((s) =>
                s.supplierId === event.supplierId
                  ? { ...s, status: "waiting" as const }
                  : s,
              );
              pushProgress(next);
              return next;
            });
            break;

          case "round_start":
            setSuppliers((prev) => {
              const next = prev.map((s) =>
                s.supplierId === event.supplierId
                  ? { ...s, currentRound: event.roundNumber, status: "negotiating" as const }
                  : s,
              );
              pushProgress(next);
              return next;
            });
            break;

          case "message":
            setSuppliers((prev) =>
              prev.map((s) =>
                s.supplierId === event.supplierId
                  ? {
                      ...s,
                      messages: [
                        ...s.messages,
                        {
                          id: event.messageId,
                          role: event.role,
                          content: event.content,
                          roundNumber: event.roundNumber,
                          phase: event.phase,
                        },
                      ],
                    }
                  : s,
              ),
            );
            break;

          case "offer_extracted":
            setSuppliers((prev) =>
              prev.map((s) =>
                s.supplierId === event.supplierId
                  ? {
                      ...s,
                      rounds: [
                        ...s.rounds,
                        {
                          roundNumber: event.roundNumber,
                          offer: event.offer,
                        },
                      ],
                    }
                  : s,
              ),
            );
            break;

          case "pillar_started": {
            const supplierName = suppliers.find((s) => s.supplierId === event.supplierId)?.supplierName ?? event.supplierId;
            setPillarActivities((prev) => {
              const next = [...prev.filter((p) => !(p.pillar === event.pillar && p.supplierId === event.supplierId && p.roundNumber === event.roundNumber)),
                { pillar: event.pillar, supplierId: event.supplierId, supplierName, roundNumber: event.roundNumber, status: "active" as const }];
              queueMicrotask(() => onPillarUpdateRef.current?.(next));
              return next;
            });
            break;
          }

          case "pillar_complete": {
            setPillarActivities((prev) => {
              const next = prev.map((p) =>
                p.pillar === event.pillar && p.supplierId === event.supplierId && p.roundNumber === event.roundNumber
                  ? { ...p, status: "complete" as const, output: event.output }
                  : p,
              );
              queueMicrotask(() => onPillarUpdateRef.current?.(next));
              return next;
            });
            break;
          }

          case "offers_snapshot":
            setScoredSnapshots((prev) => [...prev, event.offers]);
            break;

          case "round_analysis":
            setRoundAnalyses((prev) => [...prev, {
              roundNumber: event.roundNumber,
              summary: event.summary,
              supplierScores: event.supplierScores,
            }]);
            break;

          case "supplier_complete":
            setSuppliers((prev) => {
              const next = prev.map((s) =>
                s.supplierId === event.supplierId
                  ? { ...s, status: "complete" as const }
                  : s,
              );
              pushProgress(next);
              return next;
            });
            break;

          case "negotiation_complete":
            setStatus("generating_decision");
            onCompleteRef.current?.(event.negotiationId);
            break;

          case "curveball_detected":
            // Set curveball banner state
            setCurveballInfo({ description: event.description });
            // Also show as a system message in that supplier's chat
            setSuppliers((prev) =>
              prev.map((s) =>
                s.supplierId === event.supplierId
                  ? {
                      ...s,
                      messages: [
                        ...s.messages,
                        {
                          id: `curveball-${Date.now()}`,
                          role: "supplier_agent" as const,
                          content: `[CURVEBALL] ${event.description}`,
                          roundNumber: event.roundNumber,
                        },
                      ],
                    }
                  : s,
              ),
            );
            break;

          case "curveball_analysis":
            // Update curveball banner with analysis results
            setCurveballInfo((prev) => prev ? { ...prev, analysis: event.analysis } : { description: "Curveball detected", analysis: event.analysis });
            break;

          case "generating_decision":
            setStatus("generating_decision");
            break;

          case "decision":
            setStatus("complete");
            onDecisionRef.current?.({
              recommendation: event.recommendation,
              comparison: event.comparison,
              summary: event.summary,
              keyPoints: event.keyPoints as FinalDecisionData["keyPoints"],
              reasoning: event.reasoning,
              tradeoffs: event.tradeoffs,
              purchaseOrderId: event.purchaseOrderId,
              allSupplierAllocations: event.allSupplierAllocations,
            });
            break;

          case "error":
            setStatus("error");
            setErrorMessage(event.message);
            break;
        }
  }, [pushProgress]);

  // Start a new negotiation via SSE
  const startNew = useCallback(async () => {
    setStatus("connecting");
    setErrorMessage(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      setStatus("negotiating");

      await startNegotiation(quotationId, handleSSEEvent, { signal: abort.signal, maxRounds, userNotes });

    } catch (err) {
      if (abort.signal.aborted) return;
      setStatus("error");
      const errorMsg = err instanceof Error ? err.message : "Negotiation failed";
      setErrorMessage(errorMsg);
      console.error("Negotiation error:", err);
    }
  }, [quotationId, maxRounds, userNotes, handleSSEEvent]);

  // Retry negotiation
  const retryNegotiation = useCallback(async () => {
    console.log(`Retrying negotiation (attempt ${retryCount + 1})`);
    setRetryCount((prev) => prev + 1);
    await startNew();
  }, [startNew, retryCount]);

  // No separate curveball phase — curveball happens naturally in the chat

  // On mount: check for existing completed negotiation first, otherwise start fresh
  // SKIP if reQuoteParams is set — the re-quote effect handles the flow
  useEffect(() => {
    if (reQuoteParams) return;

    let cancelled = false;

    async function init() {
      if (cancelled) return;

      // Check if a completed negotiation already exists for this quotation
      const existing = await getNegotiationByQuotation(quotationId);
      if (cancelled) return;

      if (existing && existing.status === "completed") {
        // Load stored decision from DB
        const storedDecision = await getDecision(existing.id);
        if (cancelled) return;

        if (storedDecision && storedDecision.recommendation) {
          console.log(`NegotiationPanel: Found existing completed negotiation ${existing.id}`);
          setNegotiationId(existing.id);
          setStatus("complete");
          onCompleteRef.current?.(existing.id);
          onDecisionRef.current?.(storedDecision);
          return;
        }
      }

      // If a negotiation exists and is in progress, reconnect to SSE stream
      if (existing && (existing.status === "negotiating" || existing.status === "curveball")) {
        console.log(`NegotiationPanel: Reconnecting to in-progress negotiation ${existing.id} (${existing.status})`);
        setNegotiationId(existing.id);
        setStatus("connecting");
        
        // Reconnect to SSE to get live updates
        const abort = new AbortController();
        abortRef.current = abort;
        
        try {
          setStatus("negotiating");
          await startNegotiation(quotationId, handleSSEEvent, { signal: abort.signal, maxRounds, userNotes });
        } catch (err) {
          if (abort.signal.aborted) return;
          setStatus("error");
          setErrorMessage(err instanceof Error ? err.message : "Failed to reconnect");
        }
        
        return;
      }

      // No existing negotiation — start fresh
      await startNew();
    }

    init();

    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [startNew, quotationId, reQuoteParams]);

  // Re-quote: when reQuoteParams is set, reset state and start re-quote negotiation
  useEffect(() => {
    if (!reQuoteParams) return;

    const abort = new AbortController();
    abortRef.current = abort;

    // Reset local state for fresh negotiation
    setSuppliers([]);
    setStatus("connecting");
    setErrorMessage(null);
    setNegotiationId(null);
    setScoredSnapshots([]);
    setRoundAnalyses([]);
    setPillarActivities([]);
    setCurveballInfo(null);
    setExpandedChats(new Set());
    setDetailSupplierId(null);

    (async () => {
      try {
        setStatus("negotiating");

        await startReQuote(
          quotationId,
          reQuoteParams.supplierIds,
          reQuoteParams.qtyChanges,
          handleSSEEvent,
          { signal: abort.signal, maxRounds, userNotes },
        );
      } catch (err) {
        if (abort.signal.aborted) return;
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Re-quote failed");
      }
    })();

    return () => {
      abort.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reQuoteParams]);

  // OrchestrationFlow opens in a separate tab now — no inline rendering needed

  // Auto-select first tab when suppliers appear
  useEffect(() => {
    if (suppliers.length > 0 && !activeTab) {
      setActiveTab(suppliers[0].supplierId);
    }
  }, [suppliers, activeTab]);

  const insight = generateInsight(suppliers);

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {status === "negotiating" && (
            <>
              <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-sm font-medium text-gray-700">Negotiation in progress</span>
            </>
          )}
          {status === "connecting" && (
            <>
              <div className="h-2 w-2 rounded-full bg-gray-300 animate-pulse" />
              <span className="text-sm text-gray-500">Connecting...</span>
            </>
          )}
          {status === "generating_decision" && (
            <>
              <div className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              <span className="text-sm font-medium text-gray-700">Generating final decision...</span>
            </>
          )}
          {status === "complete" && (
            <>
              <div className="h-2 w-2 rounded-full bg-gray-800" />
              <span className="text-sm font-medium text-gray-700">Negotiation complete</span>
            </>
          )}
          {status === "error" && (
            <>
              <div className="h-2 w-2 rounded-full bg-red-400" />
              <span className="text-sm text-gray-700">Error: {errorMessage}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {negotiationId && (
            <>
              <a
                href={`/orchestration?id=${negotiationId}`}
                target="_blank"
                className="relative rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50 transition-all flex items-center gap-1.5"
                onMouseEnter={() => setShowFlowTooltip(true)}
                onMouseLeave={() => setShowFlowTooltip(false)}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                Flow
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <span className="text-xs text-gray-400 font-mono">{negotiationId.slice(0, 8)}</span>
            </>
          )}
        </div>
      </div>

      {/* Comparison dashboard */}
      {suppliers.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Live Offer Comparison</h3>
          <ComparisonDashboard
            suppliers={suppliers}
            onToggle={(id) => {
              setExpandedChats((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              });
            }}
            onDetailClick={(id) => setDetailSupplierId(id)}
          />

          {/* Strategy insight */}
          {insight && (
            <div className="mt-3 rounded-md bg-gray-900 px-4 py-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
                Strategy Insight
              </div>
              <p className="text-sm text-gray-300">{insight}</p>
            </div>
          )}

          {/* Round-by-round analysis slideshow */}
          {roundAnalyses.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">
                Round Analysis
              </div>
              <RoundAnalysisSlideshow analyses={roundAnalyses} />
            </div>
          )}
        </div>
      )}

      {/* Curveball banner */}
      {curveballInfo && (
        <CurveballBanner
          description={curveballInfo.description}
          analysis={curveballInfo.analysis}
          isRenegotiating={status === "negotiating" && !!curveballInfo.analysis}
        />
      )}

      {/* Supplier chats - tabbed layout */}
      {suppliers.length > 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          {/* Tab bar with auto-follow toggle */}
          <div className="flex items-stretch border-b border-gray-200 bg-gray-50/50">
            {suppliers.map((supplier) => {
              const isActive = activeTab === supplier.supplierId;
              const latestOffer = supplier.rounds
                .filter((r) => r.offer)
                .sort((a, b) => b.roundNumber - a.roundNumber)[0]?.offer ?? null;
              const hasOffer = !!latestOffer;

              // Status tag
              const statusTag = supplier.status === "negotiating"
                ? { label: "Live", color: "bg-amber-100 text-amber-700 border-amber-200" }
                : supplier.status === "complete" && hasOffer
                  ? { label: "Offer", color: "bg-emerald-100 text-emerald-700 border-emerald-200" }
                  : supplier.status === "complete"
                    ? { label: "Done", color: "bg-gray-100 text-gray-500 border-gray-200" }
                    : { label: "Queue", color: "bg-gray-100 text-gray-400 border-gray-200" };

              return (
                <button
                  key={supplier.supplierId}
                  onClick={() => setActiveTab(supplier.supplierId)}
                  className={`flex-1 px-4 py-3 text-xs font-medium transition-all relative ${
                    isActive
                      ? "text-gray-900 bg-white"
                      : "text-gray-500 hover:text-gray-700 hover:bg-gray-100/50"
                  }`}
                >
                  <div className="flex items-center justify-center gap-2">
                    <span className={`h-2 w-2 rounded-full flex-shrink-0 ${
                      supplier.status === "negotiating" ? "bg-amber-400 animate-pulse" :
                      supplier.status === "complete" ? "bg-gray-800" : "bg-gray-300"
                    }`} />
                    <span className="font-semibold truncate">{supplier.supplierName}</span>
                    <span className={`rounded-full border px-1.5 py-0.5 text-[8px] font-semibold ${statusTag.color}`}>
                      {statusTag.label}
                    </span>
                  </div>
                  {latestOffer && (
                    <div className="mt-1 text-[10px] text-gray-400 tabular-nums">
                      {formatCurrency(latestOffer.totalCost)} · {latestOffer.leadTimeDays}d · {latestOffer.paymentTerms}
                    </div>
                  )}
                  {isActive && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gray-900" />
                  )}
                </button>
              );
            })}
          </div>
          {/* Active tab content */}
          {(() => {
            const activeSupplier = suppliers.find((s) => s.supplierId === activeTab) ?? suppliers[0];
            if (!activeSupplier) return null;
            return <SupplierChat supplier={activeSupplier} fullWidth products={products} />;
          })()}
        </div>
      ) : (
        status === "error" ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-8 text-center">
            <div className="mx-auto mb-3 flex items-center justify-center h-12 w-12 rounded-full bg-red-100">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <h3 className="text-sm font-semibold text-red-900 mb-1">Negotiation Failed</h3>
            <p className="text-sm text-red-700 mb-4">{errorMessage || "An unexpected error occurred"}</p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={retryNegotiation}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Retry Negotiation
              </button>
              {retryCount > 0 && (
                <span className="text-xs text-red-600">Attempt {retryCount + 1}</span>
              )}
            </div>
            <p className="text-xs text-red-600 mt-3">
              The system will automatically reconnect if you reload the page
            </p>
          </div>
        ) : (status === "complete" || status === "generating_decision") ? (
          <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
            <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-gray-200 border-t-gray-500 animate-spin" />
            <p className="text-sm text-gray-500">
              {status === "generating_decision" ? "Generating final decision..." : "Loading decision..."}
            </p>
          </div>
        ) : status !== "idle" && (
          <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
            <div className="mx-auto mb-3 h-8 w-8 rounded-full border-2 border-gray-200 border-t-gray-500 animate-spin" />
            <p className="text-sm text-gray-500">Starting negotiation with suppliers...</p>
            {retryCount > 0 && (
              <p className="text-xs text-gray-400 mt-2">Reconnecting... (attempt {retryCount + 1})</p>
            )}
          </div>
        )
      )}

      {/* Supplier detail sidebar */}
      {detailSupplierId && (() => {
        const detailSupplier = suppliers.find((s) => s.supplierId === detailSupplierId);
        if (!detailSupplier) return null;
        return (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px]"
              onClick={() => setDetailSupplierId(null)}
            />
            <SupplierDetailSidebar
              supplier={detailSupplier}
              products={products}
              scoredSnapshots={scoredSnapshots}
              onClose={() => setDetailSupplierId(null)}
            />
          </>
        );
      })()}
    </div>
  );
}
