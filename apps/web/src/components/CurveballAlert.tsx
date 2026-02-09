"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { startCurveball } from "@/services/api-client";
import type {
  CurveballSSEEvent,
  CurveballAnalysis,
  OfferData,
  FinalDecisionData,
} from "@/services/api-client";

// ─── Types ──────────────────────────────────────────────────────────────────

interface PostCurveballMessage {
  id: string;
  role: "brand_agent" | "supplier_agent";
  content: string;
  roundNumber: number;
  supplierId: string;
  supplierName: string;
}

interface PostCurveballOffer {
  supplierId: string;
  roundNumber: number;
  offer: OfferData;
}

interface CurveballAlertProps {
  negotiationId: string;
  onDecision: (decision: FinalDecisionData) => void;
}

// ─── Format helpers ─────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function CurveballAlert({ negotiationId, onDecision }: CurveballAlertProps) {
  const [phase, setPhase] = useState<
    "idle" | "analyzing" | "renegotiating" | "deciding" | "complete" | "error"
  >("idle");
  const [description, setDescription] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<CurveballAnalysis | null>(null);
  const [messages, setMessages] = useState<PostCurveballMessage[]>([]);
  const [offers, setOffers] = useState<PostCurveballOffer[]>([]);
  const [activeSupplier, setActiveSupplier] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const decisionRef = useRef<Omit<FinalDecisionData, "purchaseOrderId"> | null>(null);

  const handleStart = useCallback(async () => {
    setPhase("analyzing");
    setErrorMessage(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      await startCurveball(negotiationId, (event: CurveballSSEEvent) => {
        switch (event.type) {
          case "curveball_injected":
            setDescription(event.description);
            break;

          case "strategy_proposed":
            setAnalysis(event.analysis);
            setPhase("renegotiating");
            break;

          case "supplier_started":
            setActiveSupplier(event.supplierName);
            break;

          case "message":
            setMessages((prev) => [
              ...prev,
              {
                id: event.messageId,
                role: event.role,
                content: event.content,
                roundNumber: event.roundNumber,
                supplierId: event.supplierId,
                supplierName: event.supplierName,
              },
            ]);
            break;

          case "offer_extracted":
            setOffers((prev) => [
              ...prev,
              {
                supplierId: event.supplierId,
                roundNumber: event.roundNumber,
                offer: event.offer,
              },
            ]);
            break;

          case "supplier_complete":
            setActiveSupplier(null);
            break;

          case "decision":
            setPhase("deciding");
            decisionRef.current = {
              recommendation: event.recommendation,
              comparison: event.comparison,
              reasoning: event.reasoning,
              tradeoffs: event.tradeoffs,
              summary: event.summary ?? "",
              keyPoints: event.keyPoints ?? [],
              allSupplierAllocations: event.allSupplierAllocations,
            };
            break;

          case "po_created":
            setPhase("complete");
            if (decisionRef.current) {
              onDecision({
                ...decisionRef.current,
                purchaseOrderId: event.purchaseOrderId,
              });
            }
            break;

          case "complete":
            setPhase("complete");
            break;

          case "error":
            setPhase("error");
            setErrorMessage(event.message);
            break;
        }
      }, { signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) return;
      setPhase("error");
      setErrorMessage(err instanceof Error ? err.message : "Curveball failed");
    }
  }, [negotiationId, onDecision]);

  // Auto-start on mount
  useEffect(() => {
    handleStart();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Group messages by supplier
  const supplierMessages = messages.reduce<
    Map<string, { supplierName: string; messages: PostCurveballMessage[] }>
  >((acc, msg) => {
    const existing = acc.get(msg.supplierId);
    if (existing) {
      existing.messages.push(msg);
    } else {
      acc.set(msg.supplierId, { supplierName: msg.supplierName, messages: [msg] });
    }
    return acc;
  }, new Map());

  return (
    <div className="space-y-4">
      {/* Alert Banner */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 text-sm font-bold">
            !
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-amber-900">Curveball Detected</h3>
            <p className="mt-1 text-sm text-amber-800">
              {description ?? "A supplier disruption has been detected. Analyzing impact..."}
            </p>
            {phase === "analyzing" && (
              <div className="mt-2 flex items-center gap-2 text-xs text-amber-600">
                <div className="h-3 w-3 rounded-full border-2 border-amber-300 border-t-amber-600 animate-spin" />
                Analyzing impact and generating strategies...
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Analysis / Strategies */}
      {analysis && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-1">Impact Analysis</h3>
            <p className="text-sm text-gray-600">{analysis.impact}</p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-gray-800 mb-2">Proposed Strategies</h3>
            <div className="space-y-3">
              {analysis.strategies.map((strategy, idx) => (
                <div key={idx} className="rounded-md border border-gray-100 bg-gray-50/50 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-gray-800">{strategy.name}</span>
                    <span className="text-sm font-semibold text-gray-900">
                      {formatCurrency(strategy.estimatedCost)}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">{strategy.description}</p>

                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {strategy.suppliers.map((s) => (
                      <span
                        key={s.supplierId}
                        className="rounded-full bg-white border border-gray-200 px-2 py-0.5 text-[11px] text-gray-600"
                      >
                        {s.supplierName}: {s.allocationPct}%
                      </span>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <span className="text-gray-400">Pros:</span>
                      <ul className="mt-0.5 space-y-0.5 text-gray-600">
                        {strategy.pros.map((p, i) => (
                          <li key={i}>+ {p}</li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <span className="text-gray-400">Cons:</span>
                      <ul className="mt-0.5 space-y-0.5 text-gray-600">
                        {strategy.cons.map((c, i) => (
                          <li key={i}>- {c}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-md bg-gray-900 p-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Recommendation
              </span>
              <p className="mt-1 text-sm text-white">{analysis.recommendation}</p>
            </div>
          </div>
        </div>
      )}

      {/* Post-Curveball Renegotiation */}
      {(phase === "renegotiating" || phase === "deciding" || phase === "complete") &&
        messages.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-semibold text-gray-800">
                Post-Curveball Renegotiation
              </h3>
              {phase === "renegotiating" && activeSupplier && (
                <span className="flex items-center gap-1.5 text-xs text-amber-600">
                  <div className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                  Negotiating with {activeSupplier}...
                </span>
              )}
            </div>

            <div className="space-y-4">
              {Array.from(supplierMessages.entries()).map(
                ([supplierId, { supplierName, messages: supplierMsgs }]) => {
                  const supplierOffers = offers.filter((o) => o.supplierId === supplierId);
                  const latestOffer = supplierOffers.sort(
                    (a, b) => b.roundNumber - a.roundNumber,
                  )[0]?.offer;

                  return (
                    <div key={supplierId} className="rounded-md border border-gray-100 p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-700">{supplierName}</span>
                        {latestOffer && (
                          <span className="text-xs font-medium text-gray-600">
                            Latest: {formatCurrency(latestOffer.totalCost)}
                          </span>
                        )}
                      </div>
                      <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {supplierMsgs.map((msg) => (
                          <div
                            key={msg.id}
                            className={`text-xs leading-relaxed ${
                              msg.role === "brand_agent"
                                ? "text-gray-500 pl-4 border-l-2 border-gray-200"
                                : "text-gray-700 pl-4 border-l-2 border-gray-400"
                            }`}
                          >
                            <span className="font-medium">
                              {msg.role === "brand_agent" ? "Brand" : supplierName}:
                            </span>{" "}
                            {msg.content.length > 300
                              ? msg.content.slice(0, 300) + "..."
                              : msg.content}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}

      {/* Status */}
      {phase === "deciding" && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <div className="h-4 w-4 rounded-full border-2 border-gray-200 border-t-gray-500 animate-spin" />
          Generating final decision and purchase order recommendation...
        </div>
      )}

      {phase === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      )}
    </div>
  );
}
