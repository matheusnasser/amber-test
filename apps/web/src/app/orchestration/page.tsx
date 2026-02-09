"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { OrchestrationFlow } from "@/components/OrchestrationFlow";
import {
  getNegotiation,
  subscribeToNegotiation,
  logout,
} from "@/services/api-client";
import type { NegotiationResponse, SSEEvent } from "@/services/api-client";

export default function OrchestrationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen bg-gray-50">
          <div className="h-8 w-8 rounded-full border-4 border-gray-200 border-t-gray-600 animate-spin" />
        </div>
      }
    >
      <OrchestrationContent />
    </Suspense>
  );
}

function OrchestrationContent() {
  const searchParams = useSearchParams();
  const negotiationId = searchParams.get("id");
  const [negotiation, setNegotiation] = useState<NegotiationResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [liveEvents, setLiveEvents] = useState<SSEEvent[]>([]);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const fetchNegotiation = useCallback(async () => {
    if (!negotiationId) return;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getNegotiation(negotiationId);
      setNegotiation(data);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load negotiation");
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [negotiationId]);

  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      setLiveEvents(prev => [...prev, event]);

      // Refetch negotiation data on any structurally significant event
      if (
        event.type === "round_end" ||
        event.type === "round_start" ||
        event.type === "supplier_started" ||
        event.type === "supplier_complete" ||
        event.type === "curveball_detected" ||
        event.type === "curveball_analysis" ||
        event.type === "decision" ||
        event.type === "negotiation_complete"
      ) {
        fetchNegotiation();
      }
      if (event.type === "negotiation_complete") {
        setIsLive(false);
        if (unsubscribeRef.current) { unsubscribeRef.current(); unsubscribeRef.current = null; }
      }
    },
    [fetchNegotiation],
  );

  useEffect(() => {
    if (!negotiationId) return;
    const init = async () => {
      const data = await fetchNegotiation();
      if (data && data.status !== "completed") {
        setIsLive(true);
        const unsub = subscribeToNegotiation(negotiationId, handleSSEEvent);
        unsubscribeRef.current = unsub;
      }
    };
    init();
    return () => { if (unsubscribeRef.current) { unsubscribeRef.current(); unsubscribeRef.current = null; } };
  }, [negotiationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Active pillar states
  const activePillars = useMemo(() => {
    return liveEvents
      .filter(e => e.type === "pillar_started" || e.type === "pillar_complete")
      .reduce((acc, e) => {
        if (e.type === "pillar_started") {
          const ev = e as Extract<SSEEvent, { type: "pillar_started" }>;
          acc[`${ev.supplierId}-${ev.pillar}`] = "active";
        } else if (e.type === "pillar_complete") {
          const ev = e as Extract<SSEEvent, { type: "pillar_complete" }>;
          acc[`${ev.supplierId}-${ev.pillar}`] = "complete";
        }
        return acc;
      }, {} as Record<string, string>);
  }, [liveEvents]);

  // Active step breadcrumb from latest event
  const activeStep = useMemo(() => {
    if (!isLive || liveEvents.length === 0) return null;
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      const e = liveEvents[i];
      if (e.type === "pillar_started") return `${e.pillar} pillar analyzing (R${e.roundNumber})`;
      if (e.type === "pillar_complete") return `${e.pillar} pillar done (R${e.roundNumber})`;
      if (e.type === "round_start") return `Round ${e.roundNumber} started`;
      if (e.type === "context_built") return `Context built: ${e.summary.slice(0, 60)}`;
      if (e.type === "message") return `${e.role === "brand_agent" ? "Alex" : e.supplierName} speaking (R${e.roundNumber})`;
      if (e.type === "offer_extracted") return `Offer extracted: $${e.offer.totalCost.toLocaleString()} (R${e.roundNumber})`;
      if (e.type === "round_end") return `Round ${e.roundNumber} complete`;
      if (e.type === "supplier_started") return `${e.supplierName} entering negotiation`;
      if (e.type === "curveball_detected") return `[CURVEBALL] ${e.description.slice(0, 60)}`;
    }
    return null;
  }, [isLive, liveEvents]);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b border-gray-200 bg-white px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">Negotiation Orchestration</h1>
            <p className="text-xs text-gray-500">
              {isLive ? "Live agent orchestration via LangGraph" : "Agent orchestration visualization"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {isLive && (
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                </span>
                <span className="text-xs font-medium text-green-600">LIVE</span>
              </div>
            )}
            {negotiation && (
              <div className="text-right">
                <p className="text-[10px] font-mono text-gray-400">{negotiation.negotiationId}</p>
                <p className="text-[10px] text-gray-500">
                  <span className={`font-medium ${negotiation.status === "completed" ? "text-green-600" : negotiation.status === "negotiating" ? "text-amber-600" : "text-gray-600"}`}>
                    {negotiation.status}
                  </span>
                  {negotiation.status === "completed" && negotiation.totalCostUsd != null && negotiation.totalCostUsd > 0 && (
                    <span className="ml-2 text-gray-400">
                      AI: ${negotiation.totalCostUsd.toFixed(4)} ({negotiation.totalTokens?.toLocaleString()} tok)
                    </span>
                  )}
                </p>
              </div>
            )}
            <button
              onClick={logout}
              className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Active step breadcrumb */}
        {activeStep && isLive && (
          <div className="mt-2 flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse flex-shrink-0" />
            <p className="text-[10px] text-blue-700 font-medium truncate">{activeStep}</p>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {!negotiationId && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-gray-500 text-sm">No negotiation ID provided</p>
              <p className="text-gray-400 text-xs mt-2">Use: /orchestration?id=&lt;negotiation-id&gt;</p>
            </div>
          </div>
        )}
        {isLoading && !negotiation && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="h-8 w-8 rounded-full border-4 border-gray-200 border-t-gray-600 animate-spin mx-auto" />
              <p className="text-gray-500 text-sm mt-4">Loading negotiation data...</p>
            </div>
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <p className="text-red-600 text-sm font-medium">Error</p>
              <p className="text-gray-600 text-sm mt-2">{error}</p>
            </div>
          </div>
        )}
        {negotiation && !error && (
          <OrchestrationFlow
            negotiation={negotiation}
            activePillars={activePillars}
            isLive={isLive}
            liveEvents={liveEvents}
          />
        )}
      </main>

      {/* Legend */}
      <footer className="border-t border-gray-200 bg-white px-6 py-2">
        <div className="flex items-center gap-4 text-[10px] text-gray-600">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border-2 border-gray-800 bg-white" />
            <span>Phase</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border-2 border-indigo-400 bg-indigo-50" />
            <span>Priorities</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border-2 border-blue-400 bg-blue-50" />
            <span>Pillar</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border-2 border-gray-600 bg-gray-50" />
            <span>Supplier</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border border-gray-300 bg-white" />
            <span>Round</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border-2 border-amber-500 bg-amber-50" />
            <span>Curveball</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded border-2 border-green-600 bg-green-50" />
            <span>Decision</span>
          </div>
          {isLive && (
            <div className="ml-auto flex items-center gap-1 text-green-600">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
              </span>
              <span>Streaming</span>
            </div>
          )}
          {!isLive && <div className="ml-auto text-gray-400">Click nodes for details</div>}
        </div>
      </footer>
    </div>
  );
}
