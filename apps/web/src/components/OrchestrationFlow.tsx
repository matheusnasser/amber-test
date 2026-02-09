"use client";

import { useMemo, useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  Position,
  MarkerType,
  Handle,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  NegotiationResponse,
  NegotiationRound,
  OfferData,
  SSEEvent,
  CurveballAnalysis,
  CurveballStrategy,
  ContextSections,
  ScoredOffer,
  FinalDecisionData,
} from "@/services/api-client";
import { getDecision } from "@/services/api-client";
// ─── Types ──────────────────────────────────────────────────────────────────

interface NodeDetail {
  id: string;
  type: string;
  title: string;
  subtitle?: string;
  round?: NegotiationRound;
  prevOffer?: OfferData | null;
  supplierName?: string;
  pillarName?: string;
  pillarOutput?: string;
  contextSummary?: string;
  contextSections?: ContextSections;
  pillarInsights?: Record<string, string>;
  /** Per-supplier pillar summaries for the decision panel: { supplierId: { pillarKey: output } } */
  supplierPillarInsights?: Record<string, Record<string, string>>;
  strategy?: CurveballStrategy;
  scoredOffers?: ScoredOffer[];
  decisionData?: FinalDecisionData;
  metadata?: Record<string, string | number>;
  timestamp?: number;
  // Decision enhancements
  supplierParams?: Map<string, SupplierParams>;
  userNotes?: string | null;
  mode?: string | null;
  negotiation?: NegotiationResponse;
}

interface SupplierParams {
  quality: number;
  priceLevel: string;
  leadTime: number;
  terms: string;
}

interface LiveState {
  activePillars: Record<string, string>;
  activeSuppliers: Set<string>;
  activeRounds: Set<string>;
  contextSummaries: Map<string, string>;
  contextData: Map<string, ContextSections>;
  pillarOutputs: Map<string, string>;
  supplierParams: Map<string, SupplierParams>;
  scoredOffers: ScoredOffer[];
  curveballAnalysis?: CurveballAnalysis;
  activeStep?: string;
  negotiationStartTime?: number;
  revealedSteps: Set<string>;
}

// ─── Manual Columnar Layout ─────────────────────────────────────────────────

const COL_WIDTH = 260;
const ROW_HEIGHT = 130;

function pos(row: number, col: number = 0): { x: number; y: number } {
  return { x: col * COL_WIDTH, y: row * ROW_HEIGHT };
}

function supplierCol(index: number, total: number): number {
  // Center supplier columns: for 3 suppliers → -1, 0, 1
  return index - Math.floor(total / 2);
}

// ─── Truncate ───────────────────────────────────────────────────────────────

function trunc(text: string, len: number): string {
  return text.length > len ? text.slice(0, len) + "..." : text;
}

// ─── Simple Markdown Renderer ────────────────────────────────────────────────

function SimpleMarkdown({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith("### ")) {
      elements.push(<p key={i} className="text-[9px] font-bold text-gray-800 mt-1.5 mb-0.5">{inlineMd(line.slice(4))}</p>);
    } else if (line.startsWith("## ")) {
      elements.push(<p key={i} className="text-[10px] font-bold text-gray-900 mt-2 mb-0.5">{inlineMd(line.slice(3))}</p>);
    } else if (line.startsWith("# ")) {
      elements.push(<p key={i} className="text-xs font-bold text-gray-900 mt-2 mb-1">{inlineMd(line.slice(2))}</p>);
    }
    // Bullet list
    else if (/^[-*] /.test(line)) {
      elements.push(<p key={i} className="text-[10px] text-gray-700 leading-snug pl-2">• {inlineMd(line.slice(2))}</p>);
    }
    // Numbered list
    else if (/^\d+\. /.test(line)) {
      const match = line.match(/^(\d+)\. (.*)$/);
      if (match) elements.push(<p key={i} className="text-[10px] text-gray-700 leading-snug pl-2">{match[1]}. {inlineMd(match[2])}</p>);
    }
    // Empty line
    else if (line.trim() === "") {
      elements.push(<div key={i} className="h-1" />);
    }
    // Normal paragraph
    else {
      elements.push(<p key={i} className="text-[10px] text-gray-700 leading-snug">{inlineMd(line)}</p>);
    }
  }

  return <div className={className}>{elements}</div>;
}

function inlineMd(text: string): React.ReactNode {
  // Handle **bold**, *italic*, `code`
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Code
    const codeMatch = remaining.match(/`(.+?)`/);
    // Pick earliest match
    const matches = [
      boldMatch ? { type: "bold", match: boldMatch, index: boldMatch.index! } : null,
      codeMatch ? { type: "code", match: codeMatch, index: codeMatch.index! } : null,
    ].filter(Boolean).sort((a, b) => a!.index - b!.index);

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const m = matches[0]!;
    if (m.index > 0) {
      parts.push(remaining.slice(0, m.index));
    }

    if (m.type === "bold") {
      parts.push(<strong key={key++} className="font-semibold">{m.match[1]}</strong>);
    } else if (m.type === "code") {
      parts.push(<code key={key++} className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-[9px] font-mono">{m.match[1]}</code>);
    }

    remaining = remaining.slice(m.index + m.match[0].length);
  }

  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : <>{parts}</>;
}

// ─── Custom Node Components ─────────────────────────────────────────────────

function PhaseNode({ data }: { data: Record<string, unknown> }) {
  const { label, subtitle, status, isActive } = data as {
    label: string; subtitle?: string; status?: string; isActive?: boolean;
  };
  return (
    <div className={`rounded-xl border-2 bg-white px-5 py-3 shadow-md min-w-[200px] cursor-pointer transition-all duration-300 ${isActive ? "border-blue-500 shadow-blue-200 shadow-lg" : "border-gray-800"}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-800 !w-2 !h-2" />
      <div className="text-center">
        <p className="text-xs font-bold text-gray-900">{label}</p>
        {subtitle && <p className="text-[10px] text-gray-500 mt-0.5">{subtitle}</p>}
        {status && (
          <span className={`inline-block mt-1.5 text-[9px] font-medium px-2 py-0.5 rounded-full ${status === "complete" ? "bg-green-100 text-green-700" : status === "active" ? "bg-blue-100 text-blue-700 animate-pulse" : "bg-gray-100 text-gray-500"}`}>
            {status === "active" ? "processing..." : status}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-gray-800 !w-2 !h-2" />
    </div>
  );
}

function UserPrioritiesNode({ data }: { data: Record<string, unknown> }) {
  const { notes, mode } = data as { notes?: string; mode?: string };
  return (
    <div className="rounded-xl border-2 border-indigo-400 bg-indigo-50 px-5 py-3 shadow-sm min-w-[240px] max-w-[300px] cursor-pointer">
      <Handle type="target" position={Position.Top} className="!bg-indigo-400 !w-2 !h-2" />
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[9px] font-bold text-indigo-600 uppercase tracking-wider">User Inputs</span>
          {mode && <span className="text-[9px] font-medium bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">{mode}</span>}
        </div>
        {notes ? (
          <p className="text-[10px] text-indigo-800 leading-snug line-clamp-3">{notes}</p>
        ) : (
          <p className="text-[10px] text-indigo-400 italic">No specific priorities set</p>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-indigo-400 !w-2 !h-2" />
    </div>
  );
}

function SupplierNode({ data }: { data: Record<string, unknown> }) {
  const { label, code, roundCount, isXlsxSource, isActive, quality, priceLevel, leadTime, terms } = data as {
    label: string; code: string; roundCount: number; isXlsxSource?: boolean; isActive?: boolean;
    quality?: number; priceLevel?: string; leadTime?: number; terms?: string;
  };
  return (
    <div className={`rounded-xl border-2 bg-gray-50 px-4 py-2.5 shadow-sm min-w-[200px] cursor-pointer transition-all duration-300 ${isActive ? "border-blue-500 shadow-blue-200 shadow-lg bg-blue-50/30" : "border-gray-600"}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-600 !w-2 !h-2" />
      <div className="text-center">
        <div className="flex items-center justify-center gap-1.5">
          {isActive && <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />}
          <p className="text-xs font-semibold text-gray-800">{label}</p>
          {isXlsxSource && <span className="text-[8px] font-medium bg-amber-100 text-amber-700 px-1 py-0.5 rounded">XLSX</span>}
        </div>
        <p className="text-[9px] text-gray-400 font-mono">{code}</p>
        {quality != null && (
          <p className="text-[9px] text-gray-500 mt-0.5">
            {quality}q · {leadTime}d · {terms} · {priceLevel}
          </p>
        )}
        <p className="text-[10px] text-gray-500">{roundCount} round{roundCount !== 1 ? "s" : ""}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-gray-600 !w-2 !h-2" />
    </div>
  );
}

function RoundNode({ data }: { data: Record<string, unknown> }) {
  const { round, phase, offer, messageCount, brandExcerpt, supplierExcerpt, isActive, contextSummary, pillarSummary, relativeTime, isXlsxR1, prevOffer } = data as {
    round: number; phase: string; offer: OfferData | null; messageCount: number;
    brandExcerpt?: string; supplierExcerpt?: string; isActive?: boolean;
    contextSummary?: string; pillarSummary?: string; relativeTime?: string; isXlsxR1?: boolean;
    prevOffer?: OfferData | null;
  };
  const isPost = phase === "post_curveball";
  const baseColor = isPost ? "border-amber-400 bg-amber-50" : "border-gray-300 bg-white";
  const activeColor = "border-blue-400 bg-blue-50/50 shadow-blue-200 shadow-lg";

  // Compute deltas vs previous round
  const costDelta = offer && prevOffer ? offer.totalCost - prevOffer.totalCost : null;
  const leadDelta = offer && prevOffer ? offer.leadTimeDays - prevOffer.leadTimeDays : null;
  const termsChanged = offer && prevOffer ? offer.paymentTerms !== prevOffer.paymentTerms : false;

  return (
    <div className={`rounded-lg border px-3 py-2.5 shadow-sm min-w-[185px] max-w-[220px] cursor-pointer transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${isActive ? activeColor : baseColor}`}>
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-1.5 !h-1.5" />
      <div>
        <div className="flex items-center justify-between mb-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold text-gray-600 uppercase">{isPost ? "Post-CB" : "R"}{round}</span>
            {isXlsxR1 && <span className="text-[7px] font-medium bg-amber-100 text-amber-700 px-1 py-0.5 rounded">XLSX Offer</span>}
          </div>
          <div className="flex items-center gap-1">
            {isActive && <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />}
            {relativeTime && <span className="text-[8px] text-gray-300 font-mono">{relativeTime}</span>}
            <span className="text-[9px] text-gray-400">{messageCount} msg</span>
          </div>
        </div>
        {offer && offer.totalCost > 0 && (
          <p className="text-sm font-bold text-gray-900">${offer.totalCost.toLocaleString("en-US", { maximumFractionDigits: 0 })}</p>
        )}
        {offer && offer.totalCost === 0 && (
          <p className="text-xs text-gray-400 italic">Offer pending</p>
        )}
        {/* Round changes — wins (green/brand) and losses (red/supplier) */}
        {prevOffer && offer && (costDelta !== 0 || (leadDelta !== null && leadDelta !== 0) || termsChanged) && (
          <div className="flex flex-wrap items-center gap-1 mt-0.5">
            {costDelta !== null && costDelta !== 0 && (
              <span className={`text-[8px] font-semibold px-1 py-0.5 rounded ${costDelta < 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
                title={costDelta < 0 ? "Win: price dropped" : "Loss: price increased"}>
                {costDelta < 0 ? "↓" : "↑"}${Math.abs(costDelta).toLocaleString("en-US", { maximumFractionDigits: 0 })}
          </span>
            )}
            {leadDelta !== null && leadDelta !== 0 && (
              <span className={`text-[8px] font-semibold px-1 py-0.5 rounded ${leadDelta < 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
                title={leadDelta < 0 ? "Win: faster delivery" : "Loss: slower delivery"}>
                {leadDelta < 0 ? "↓" : "↑"}{Math.abs(leadDelta)}d
              </span>
            )}
            {termsChanged && (
              <span className="text-[8px] font-semibold px-1 py-0.5 rounded bg-blue-100 text-blue-700"
                title={`Terms: ${prevOffer.paymentTerms} → ${offer.paymentTerms}`}>
                {prevOffer.paymentTerms} → {offer.paymentTerms}
              </span>
            )}
        </div>
        )}
        {offer && (
          <div className="flex items-center gap-1.5 text-[9px] text-gray-500 mt-0.5">
            <span>{offer.leadTimeDays}d</span>
            <span className="text-gray-300">|</span>
            <span>{offer.paymentTerms}</span>
          </div>
        )}
        {contextSummary && (
          <p className="mt-1 text-[8px] text-indigo-500 leading-tight line-clamp-1" title={contextSummary}>
            ctx: {trunc(contextSummary, 50)}
          </p>
        )}
        {pillarSummary && (
          <p className="text-[8px] text-purple-500 leading-tight line-clamp-1" title={pillarSummary}>
            pillars: {trunc(pillarSummary, 50)}
          </p>
        )}
        {brandExcerpt && (
          <p className="mt-0.5 text-[9px] text-blue-600 leading-tight line-clamp-1" title={brandExcerpt}>
            Alex: {trunc(brandExcerpt, 40)}
          </p>
        )}
        {supplierExcerpt && (
          <p className="text-[9px] text-gray-600 leading-tight line-clamp-1" title={supplierExcerpt}>
            Sup: {trunc(supplierExcerpt, 40)}
          </p>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-1.5 !h-1.5" />
    </div>
  );
}

function PillarNode({ data }: { data: Record<string, unknown> }) {
  const { label, pillar, status } = data as { label: string; pillar: string; status: string };
  const colors = {
    active: { border: "border-blue-400 bg-blue-50 shadow-blue-100 shadow-md", dot: "bg-blue-500 animate-pulse" },
    complete: { border: "border-green-400 bg-green-50", dot: "bg-green-500" },
    pending: { border: "border-gray-300 bg-gray-50", dot: "bg-gray-300" },
  };
  const c = colors[status as keyof typeof colors] ?? colors.pending;
  return (
    <div className={`rounded-lg border ${c.border} px-3 py-1.5 min-w-[120px] max-w-[140px] cursor-pointer transition-all duration-300`}>
      <Handle type="target" position={Position.Top} className="!bg-blue-400 !w-1.5 !h-1.5" />
      <div className="flex items-center gap-1.5">
        <span className={`flex-shrink-0 h-1.5 w-1.5 rounded-full ${c.dot}`} />
        <div>
          <p className="text-[9px] font-semibold text-gray-700 uppercase tracking-wide">{label}</p>
          <p className="text-[8px] text-gray-400">{pillar}</p>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-400 !w-1.5 !h-1.5" />
    </div>
  );
}

function SynthesizerNode({ data }: { data: Record<string, unknown> }) {
  const { label, status } = data as { label: string; status: string };
  const isActive = status === "active";
  return (
    <div className={`rounded-lg border-2 cursor-pointer transition-all duration-300 ${isActive ? "border-purple-400 bg-purple-50 shadow-md shadow-purple-200" : "border-purple-300 bg-purple-50/60"} px-3 py-1.5 min-w-[140px]`}>
      <Handle type="target" position={Position.Top} className="!bg-purple-400 !w-1.5 !h-1.5" />
      <div className="text-center">
        <p className="text-[9px] font-bold text-purple-700 uppercase tracking-wider">{label}</p>
        <p className="text-[8px] text-purple-500">Merges pillars</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-purple-400 !w-1.5 !h-1.5" />
    </div>
  );
}

function CurveballNode({ data }: { data: Record<string, unknown> }) {
  const { label } = data as { label: string };
  return (
    <div className="rounded-xl border-2 border-amber-500 bg-amber-50 px-5 py-3 shadow-md min-w-[240px] cursor-pointer">
      <Handle type="target" position={Position.Top} className="!bg-amber-500 !w-2 !h-2" />
      <div className="text-center">
        <p className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">Curveball Event</p>
        <p className="text-[9px] text-amber-600 mt-0.5 leading-tight">{trunc(label, 80)}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-500 !w-2 !h-2" />
    </div>
  );
}

function StrategyNode({ data }: { data: Record<string, unknown> }) {
  const { strategy, isRecommended } = data as { strategy: CurveballStrategy; isRecommended: boolean };
  return (
    <div className={`rounded-lg border-2 px-3 py-2.5 min-w-[180px] max-w-[200px] cursor-pointer transition-all ${isRecommended ? "border-green-500 bg-green-50 shadow-sm shadow-green-100" : "border-gray-300 bg-white"}`}>
      <Handle type="target" position={Position.Top} className="!bg-amber-400 !w-1.5 !h-1.5" />
      <div>
        <div className="flex items-center gap-1 mb-1">
          {isRecommended && <span className="text-[7px] font-bold bg-green-600 text-white px-1 py-0.5 rounded">BEST</span>}
          <p className="text-[9px] font-semibold text-gray-800">{strategy.name}</p>
        </div>
        <p className="text-[8px] text-gray-500 leading-tight line-clamp-2">{strategy.description}</p>
        <div className="mt-1 flex items-center gap-2 text-[8px]">
          <span className="font-medium text-gray-700">${(strategy.estimatedCost / 1000).toFixed(1)}K</span>
          <span className="text-gray-300">|</span>
          <span className="text-gray-500">{strategy.suppliers.map(s => `${s.supplierName.split(" ")[0]} ${s.allocationPct}%`).join(", ")}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[8px]">
          <span className="text-green-600">+{strategy.pros.length} pros</span>
          <span className="text-red-500">-{strategy.cons.length} cons</span>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-amber-400 !w-1.5 !h-1.5" />
    </div>
  );
}

function DecisionNode({ data }: { data: Record<string, unknown> }) {
  const { label, subtitle, isComplete } = data as { label: string; subtitle?: string; isComplete?: boolean };
  return (
    <div className={`rounded-xl border-2 border-green-600 bg-green-50 px-5 py-3 shadow-md min-w-[220px] cursor-pointer transition-all hover:shadow-lg hover:shadow-green-200 ${isComplete ? "ring-2 ring-green-300 ring-offset-2" : ""}`}>
      <Handle type="target" position={Position.Top} className="!bg-green-600 !w-2 !h-2" />
      <div className="text-center">
        <p className="text-xs font-bold text-green-800">{label}</p>
        {subtitle && <p className="text-[10px] text-green-600 mt-0.5">{subtitle}</p>}
        {isComplete && <p className="text-[8px] text-green-500 mt-1 animate-pulse">Click for details</p>}
      </div>
    </div>
  );
}

function CrossPollinationNode({ data }: { data: Record<string, unknown> }) {
  const { label } = data as { label: string };
  return (
    <div className="rounded-lg border border-dashed border-gray-400 bg-gray-50/80 px-3 py-1.5 min-w-[220px]">
      <Handle type="target" position={Position.Top} className="!bg-gray-400 !w-1.5 !h-1.5" />
      <p className="text-[9px] text-gray-500 text-center">{label}</p>
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400 !w-1.5 !h-1.5" />
    </div>
  );
}

// ─── Node Types ─────────────────────────────────────────────────────────────

const nodeTypes = {
  phase: PhaseNode,
  userPriorities: UserPrioritiesNode,
  supplier: SupplierNode,
  round: RoundNode,
  curveball: CurveballNode,
  strategy: StrategyNode,
  crossPollination: CrossPollinationNode,
  decision: DecisionNode,
  pillar: PillarNode,
  synthesizer: SynthesizerNode,
};

// ─── Build Graph (manual columnar layout) ───────────────────────────────────

function buildGraph(
  negotiation: NegotiationResponse,
  liveState?: LiveState,
): { nodes: Node[]; edges: Edge[]; roundMap: Map<string, NegotiationRound> } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const roundMap = new Map<string, NegotiationRound>();

  const nSuppliers = negotiation.suppliers.length;
  let currentRow = 0;
  const startTime = liveState?.negotiationStartTime;
  const relTime = (ts?: number) => {
    if (!ts || !startTime) return undefined;
    return `+${((ts - startTime) / 1000).toFixed(1)}s`;
  };

  // 1. Parse (centered)
  nodes.push({ id: "parse", type: "phase", position: pos(currentRow, 0), data: { label: "XLSX Parse & Product Match", subtitle: `${nSuppliers} suppliers`, status: "complete" } });
  currentRow++;

  // 2. User priorities
  nodes.push({ id: "priorities", type: "userPriorities", position: pos(currentRow, 0), data: { notes: negotiation.userNotes, mode: negotiation.mode } });
  edges.push({ id: "parse->priorities", source: "parse", target: "priorities", style: { stroke: "#1f2937" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#1f2937" } });
  currentRow++;

  // 3. BrandGraph
  const anyPillarActive = liveState ? Object.values(liveState.activePillars).some(s => s === "active") : false;
  nodes.push({ id: "brand-graph", type: "phase", position: pos(currentRow, 0), data: { label: "BrandGraph (LangGraph)", subtitle: "3-pillar analysis + synthesizer", status: anyPillarActive ? "active" : "complete", isActive: anyPillarActive } });
  edges.push({ id: "priorities->brand", source: "priorities", target: "brand-graph", style: { stroke: "#1f2937" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#1f2937" } });
  currentRow++;

  // 3b. Pillars (spread across columns)
  const pillars = [
    { id: "negotiator", label: "Negotiator", desc: "Competitive bidding" },
    { id: "riskAnalyst", label: "Risk", desc: "Supply chain risk" },
    { id: "productCost", label: "Cost", desc: "SKU & cash flow" },
  ];

  pillars.forEach((pillar, idx) => {
    const pId = `pillar-${pillar.id}`;
    let status = "complete";
    if (liveState) {
      for (const key of Object.keys(liveState.activePillars)) {
        if (key.endsWith(`-${pillar.id}`)) {
          const s = liveState.activePillars[key];
          if (s === "active") { status = "active"; break; }
          status = s;
        }
      }
    }
    nodes.push({ id: pId, type: "pillar", position: pos(currentRow, supplierCol(idx, 3)), data: { label: pillar.label, pillar: pillar.desc, status } });
    edges.push({ id: `brand->${pId}`, source: "brand-graph", target: pId, style: { stroke: "#3b82f6", strokeDasharray: "4,2" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#3b82f6" }, animated: status === "active" });
  });
  currentRow++;

  // 3c. Synthesizer
  nodes.push({ id: "synthesizer", type: "synthesizer", position: pos(currentRow, 0), data: { label: "Synthesizer", status: anyPillarActive ? "pending" : "complete" } });
  pillars.forEach(pillar => {
    edges.push({ id: `pillar-${pillar.id}->synth`, source: `pillar-${pillar.id}`, target: "synthesizer", style: { stroke: "#8b5cf6", strokeDasharray: "4,2" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#8b5cf6" } });
  });
  currentRow++;

  // 4. Supplier headers (spread in columns)
  negotiation.suppliers.forEach((supplier, idx) => {
    const sId = `supplier-${supplier.supplierId}`;
    const isActive = liveState?.activeSuppliers.has(supplier.supplierId) ?? false;
    const params = liveState?.supplierParams.get(supplier.supplierId);
    nodes.push({ id: sId, type: "supplier", position: pos(currentRow, supplierCol(idx, nSuppliers)), data: {
      label: supplier.supplierName, code: supplier.supplierCode,
        roundCount: supplier.rounds.length,
      isXlsxSource: supplier.supplierCode === "SUP-001", isActive,
      quality: params?.quality, priceLevel: params?.priceLevel, leadTime: params?.leadTime, terms: params?.terms,
    }});
    edges.push({ id: `synth->${sId}`, source: "synthesizer", target: sId, animated: isActive, style: { stroke: isActive ? "#3b82f6" : "#4b5563" }, markerEnd: { type: MarkerType.ArrowClosed, color: isActive ? "#3b82f6" : "#4b5563" } });
  });
  currentRow++;

  // 5. Initial rounds (each round = one row, each supplier = one column)
  const maxInitialRounds = Math.max(...negotiation.suppliers.map(s => s.rounds.filter(r => r.phase === "initial").length), 0);

  for (let rIdx = 0; rIdx < maxInitialRounds; rIdx++) {
    negotiation.suppliers.forEach((supplier, sIdx) => {
      const round = supplier.rounds.filter(r => r.phase === "initial")[rIdx];
      if (!round) return;

      const nId = `round-${supplier.supplierId}-${round.roundNumber}`;
      const brandMsg = round.messages.find(m => m.role === "brand_agent");
      const supplierMsg = round.messages.find(m => m.role === "supplier_agent");
      const isActive = liveState?.activeRounds.has(`${supplier.supplierId}-${round.roundNumber}`) ?? false;

      const ctxKey = `${supplier.supplierId}-${round.roundNumber}`;
      const contextSummary = liveState?.contextSummaries.get(ctxKey)
        ?? round.offerData?._contextSummary
        ?? undefined;
      const pillarKeys = ["negotiator", "riskAnalyst", "productCost"];
      const pillarInsights: string[] = [];
      for (const pk of pillarKeys) {
        const output = liveState?.pillarOutputs.get(`${ctxKey}-${pk}`)
          ?? round.offerData?._pillarOutputs?.[pk];
        if (output) pillarInsights.push(trunc(output, 40));
      }

      const isXlsxR1 = supplier.supplierCode === "SUP-001" && round.roundNumber === 1;

      // Previous round's offer for delta display
      const prevRound = rIdx > 0 ? supplier.rounds.filter(r => r.phase === "initial")[rIdx - 1] : undefined;
      const prevOffer = prevRound?.offerData ?? null;

      roundMap.set(nId, round);
      nodes.push({ id: nId, type: "round", position: pos(currentRow, supplierCol(sIdx, nSuppliers)), data: {
        round: round.roundNumber, phase: round.phase, offer: round.offerData,
          messageCount: round.messages.length,
        brandExcerpt: brandMsg ? trunc(brandMsg.content, 50) : undefined,
        supplierExcerpt: supplierMsg ? trunc(supplierMsg.content, 50) : undefined,
        isActive, contextSummary,
        pillarSummary: pillarInsights.length > 0 ? pillarInsights.join(" | ") : undefined,
        isXlsxR1, prevOffer,
      }});

      const prevId = rIdx === 0 ? `supplier-${supplier.supplierId}` : `round-${supplier.supplierId}-${supplier.rounds.filter(r => r.phase === "initial")[rIdx - 1]?.roundNumber}`;
      if (prevId) {
        edges.push({ id: `${prevId}->${nId}`, source: prevId, target: nId, style: { stroke: isActive ? "#3b82f6" : "#9ca3af" }, markerEnd: { type: MarkerType.ArrowClosed, color: isActive ? "#3b82f6" : "#9ca3af" }, animated: isActive });
      }
    });
    currentRow++;
  }

  // 6. Curveball
  const hasPostCurveball = negotiation.suppliers.some(s => s.rounds.some(r => r.phase === "post_curveball"));
  const curveballAnalysis = liveState?.curveballAnalysis;
  const curveballDesc = negotiation.suppliers[1]?.supplierName
    ? `${negotiation.suppliers[1].supplierName} can only fulfill 60% — re-evaluating strategy`
    : "Supplier capacity disruption — re-evaluating";

  if (hasPostCurveball || curveballAnalysis) {
    nodes.push({ id: "curveball", type: "curveball", position: pos(currentRow, 0), data: { label: curveballDesc } });
    negotiation.suppliers.forEach(supplier => {
      const initialRounds = supplier.rounds.filter(r => r.phase === "initial");
      const lastInitial = initialRounds[initialRounds.length - 1];
      if (lastInitial) {
        edges.push({ id: `round-${supplier.supplierId}-${lastInitial.roundNumber}->cb`, source: `round-${supplier.supplierId}-${lastInitial.roundNumber}`, target: "curveball", style: { stroke: "#f59e0b", strokeDasharray: "5,5" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#f59e0b" } });
      }
    });
    currentRow++;

    // Strategy nodes
    if (curveballAnalysis && curveballAnalysis.strategies.length > 0) {
      curveballAnalysis.strategies.forEach((strategy, idx) => {
        const sId = `strategy-${idx}`;
        const isRecommended = curveballAnalysis.recommendation.toLowerCase().includes(strategy.name.toLowerCase());
        nodes.push({ id: sId, type: "strategy", position: pos(currentRow, supplierCol(idx, curveballAnalysis.strategies.length)), data: { strategy, isRecommended } });
        edges.push({ id: `cb->${sId}`, source: "curveball", target: sId, style: { stroke: isRecommended ? "#16a34a" : "#d1d5db", strokeWidth: isRecommended ? 2 : 1 }, markerEnd: { type: MarkerType.ArrowClosed, color: isRecommended ? "#16a34a" : "#d1d5db" }, label: isRecommended ? "recommended" : undefined, labelStyle: { fontSize: 8, fill: "#16a34a", fontWeight: 600 } });
      });
      currentRow++;
    }

    // Post-curveball rounds
    const maxPostRounds = Math.max(...negotiation.suppliers.map(s => s.rounds.filter(r => r.phase === "post_curveball").length), 0);
    for (let rIdx = 0; rIdx < maxPostRounds; rIdx++) {
      negotiation.suppliers.forEach((supplier, sIdx) => {
        const round = supplier.rounds.filter(r => r.phase === "post_curveball")[rIdx];
        if (!round) return;
        const nId = `postround-${supplier.supplierId}-${round.roundNumber}`;
        const brandMsg = round.messages.find(m => m.role === "brand_agent");
        const supplierMsg = round.messages.find(m => m.role === "supplier_agent");
        // Previous round's offer for delta
        const prevPostRound = rIdx > 0 ? supplier.rounds.filter(r => r.phase === "post_curveball")[rIdx - 1] : undefined;
        const prevPostOffer = prevPostRound?.offerData ?? (rIdx === 0 ? supplier.rounds.filter(r => r.phase === "initial").pop()?.offerData : null) ?? null;

        roundMap.set(nId, round);
        nodes.push({ id: nId, type: "round", position: pos(currentRow, supplierCol(sIdx, nSuppliers)), data: {
          round: round.roundNumber, phase: round.phase, offer: round.offerData,
          messageCount: round.messages.length,
          brandExcerpt: brandMsg ? trunc(brandMsg.content, 50) : undefined,
          supplierExcerpt: supplierMsg ? trunc(supplierMsg.content, 50) : undefined,
          prevOffer: prevPostOffer,
        }});

        const prevId = rIdx === 0
          ? (curveballAnalysis && curveballAnalysis.strategies.length > 0 ? undefined : "curveball")
          : `postround-${supplier.supplierId}-${supplier.rounds.filter(r => r.phase === "post_curveball")[rIdx - 1]?.roundNumber}`;
        if (prevId) {
          edges.push({ id: `${prevId}->${nId}`, source: prevId, target: nId, style: { stroke: "#f59e0b" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#f59e0b" } });
        }
      });
      currentRow++;
    }
  }

  // 7. Decision
  nodes.push({ id: "decision", type: "decision", position: pos(currentRow, 0), data: {
    label: "Final Decision",
    subtitle: negotiation.status === "completed" ? "Best choice over tradeoffs → PO" : "Pending...",
    isComplete: negotiation.status === "completed",
  }});
  negotiation.suppliers.forEach(supplier => {
    const allRounds = supplier.rounds;
    const lastRound = allRounds[allRounds.length - 1];
    if (lastRound) {
      const prefix = lastRound.phase === "post_curveball" ? "postround" : "round";
      edges.push({ id: `${prefix}-${supplier.supplierId}-${lastRound.roundNumber}->decision`, source: `${prefix}-${supplier.supplierId}-${lastRound.roundNumber}`, target: "decision", style: { stroke: "#16a34a" }, markerEnd: { type: MarkerType.ArrowClosed, color: "#16a34a" } });
    }
  });

  return { nodes, edges, roundMap };
}

// ─── Detail Panel ───────────────────────────────────────────────────────────

function DetailPanel({ detail, onClose }: { detail: NodeDetail; onClose: () => void }) {
  const [showMessages, setShowMessages] = useState(false);
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);

  return (
    <div className="absolute top-0 right-0 h-full w-[420px] bg-white border-l border-gray-200 shadow-xl z-50 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
        <div>
          <p className="text-sm font-bold text-gray-900">{detail.title}</p>
          <div className="flex items-center gap-2">
            {detail.subtitle && <p className="text-[10px] text-gray-500">{detail.subtitle}</p>}
            {detail.timestamp && (
              <span className="text-[9px] text-gray-300 font-mono">{new Date(detail.timestamp).toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm leading-none p-1 rounded hover:bg-gray-100">x</button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* Metadata */}
        {detail.metadata && Object.keys(detail.metadata).length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Details</p>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(detail.metadata).map(([key, value]) => (
                <div key={key} className="bg-gray-50 rounded px-2.5 py-1.5">
                  <p className="text-[8px] text-gray-400 uppercase">{key}</p>
                  <p className="text-xs font-medium text-gray-800">{typeof value === "number" ? value.toLocaleString() : value}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Structured Context Sections */}
        {detail.contextSections && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Context Sent to Agent</p>

            {/* Quotation table */}
            {detail.contextSections.quotationItems.length > 0 && (
              <details className="mb-2">
                <summary className="text-[9px] font-medium text-indigo-600 cursor-pointer hover:text-indigo-800">
                  Quotation Items ({detail.contextSections.quotationItems.length})
                </summary>
                <table className="mt-1 w-full text-[9px] border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left py-1 px-1.5 font-medium text-gray-500">SKU</th>
                      <th className="text-right py-1 px-1.5 font-medium text-gray-500">Qty</th>
                      <th className="text-right py-1 px-1.5 font-medium text-gray-500">Unit $</th>
                      <th className="text-right py-1 px-1.5 font-medium text-gray-500">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.contextSections.quotationItems.map((item, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1 px-1.5 font-mono text-gray-700" title={item.description}>{item.sku}</td>
                        <td className="text-right py-1 px-1.5 text-gray-600">{item.qty}</td>
                        <td className="text-right py-1 px-1.5 text-gray-600">${item.unitPrice.toFixed(2)}</td>
                        <td className="text-right py-1 px-1.5 text-gray-800 font-medium">${item.totalPrice.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {/* Supplier profile */}
            {detail.contextSections.supplierProfile && (
              <details className="mb-2" open>
                <summary className="text-[9px] font-medium text-indigo-600 cursor-pointer hover:text-indigo-800">Supplier Profile</summary>
                <div className="mt-1 grid grid-cols-2 gap-1 text-[9px]">
                  <div className="bg-indigo-50 rounded px-2 py-1"><span className="text-gray-400">Quality</span> <span className="font-medium text-gray-800">{detail.contextSections.supplierProfile.quality}/5</span></div>
                  <div className="bg-indigo-50 rounded px-2 py-1"><span className="text-gray-400">Price</span> <span className="font-medium text-gray-800">{detail.contextSections.supplierProfile.priceLevel}</span></div>
                  <div className="bg-indigo-50 rounded px-2 py-1"><span className="text-gray-400">Lead</span> <span className="font-medium text-gray-800">{detail.contextSections.supplierProfile.leadTime}d</span></div>
                  <div className="bg-indigo-50 rounded px-2 py-1"><span className="text-gray-400">Terms</span> <span className="font-medium text-gray-800">{detail.contextSections.supplierProfile.terms}</span></div>
                </div>
              </details>
            )}

            {/* Competitive intel */}
            {detail.contextSections.competitiveIntel.length > 0 && (
              <details className="mb-2">
                <summary className="text-[9px] font-medium text-indigo-600 cursor-pointer hover:text-indigo-800">
                  Competitive Intelligence ({detail.contextSections.competitiveIntel.length} suppliers)
                </summary>
                <table className="mt-1 w-full text-[9px] border-collapse">
                  <thead>
                    <tr className="border-b border-gray-200 bg-gray-50">
                      <th className="text-left py-1 px-1.5 font-medium text-gray-500">Supplier</th>
                      <th className="text-right py-1 px-1.5 font-medium text-gray-500">Cost</th>
                      <th className="text-right py-1 px-1.5 font-medium text-gray-500">Lead</th>
                      <th className="text-left py-1 px-1.5 font-medium text-gray-500">Terms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.contextSections.competitiveIntel.map((ci, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-1 px-1.5 text-gray-700">{ci.label}</td>
                        <td className="text-right py-1 px-1.5 text-gray-800 font-medium">${ci.totalCost.toLocaleString()}</td>
                        <td className="text-right py-1 px-1.5 text-gray-600">{ci.leadTime}d</td>
                        <td className="py-1 px-1.5 text-gray-600">{ci.terms}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}

            {/* Risk flags */}
            {detail.contextSections.riskFlags.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded px-2.5 py-1.5 mb-2">
                <p className="text-[8px] font-semibold text-red-700 uppercase mb-0.5">Risk Flags</p>
                {detail.contextSections.riskFlags.map((f, i) => <p key={i} className="text-[9px] text-red-800">- {f}</p>)}
              </div>
            )}

            {/* User priorities */}
            {detail.contextSections.userPriorities && (
              <div className="bg-blue-50 border border-blue-200 rounded px-2.5 py-1.5 mb-2">
                <p className="text-[8px] font-semibold text-blue-700 uppercase mb-0.5">User Priorities</p>
                <p className="text-[9px] text-blue-800">{detail.contextSections.userPriorities}</p>
              </div>
            )}

            {/* Round strategy (markdown) */}
            {detail.contextSections.roundStrategy && (
              <div className="bg-gray-50 border border-gray-200 rounded px-2.5 py-1.5">
                <p className="text-[8px] font-semibold text-gray-500 uppercase mb-0.5">Strategy</p>
                <SimpleMarkdown text={detail.contextSections.roundStrategy} />
              </div>
            )}
          </div>
        )}

        {/* Context summary (fallback if no structured data) */}
        {detail.contextSummary && !detail.contextSections && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Context Builder</p>
            <div className="bg-indigo-50 border border-indigo-200 rounded px-3 py-2">
              <p className="text-[10px] text-indigo-800">{detail.contextSummary}</p>
            </div>
          </div>
        )}

        {/* Pillar insights (rendered as markdown) */}
        {detail.pillarInsights && Object.keys(detail.pillarInsights).length > 0 && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Pillar Insights</p>
            <div className="space-y-1.5">
              {Object.entries(detail.pillarInsights).map(([pillar, insight]) => {
                const colors: Record<string, string> = { negotiator: "bg-blue-50 border-blue-200", riskAnalyst: "bg-amber-50 border-amber-200", productCost: "bg-green-50 border-green-200" };
                const labels: Record<string, string> = { negotiator: "Negotiator", riskAnalyst: "Risk Analyst", productCost: "Product/Cost" };
                return (
                  <details key={pillar} open className={`border rounded px-3 py-2 ${colors[pillar] ?? "bg-gray-50 border-gray-200"}`}>
                    <summary className="text-[8px] font-semibold uppercase cursor-pointer hover:opacity-80">{labels[pillar] ?? pillar}</summary>
                    <SimpleMarkdown text={insight} className="mt-1" />
                  </details>
                );
              })}
            </div>
          </div>
        )}

        {/* Messages (collapsible) */}
        {detail.round && detail.round.messages.length > 0 && (
          <div>
            <button
              onClick={() => setShowMessages(!showMessages)}
              className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 hover:text-gray-600 flex items-center gap-1"
            >
              <span>{showMessages ? "▼" : "▶"}</span>
              Conversation ({detail.round.messages.length} messages)
            </button>
            {showMessages && (
              <div className="space-y-2">
                {detail.round.messages.map(msg => (
                  <div key={msg.id} className={`rounded-lg px-3 py-2 text-xs leading-relaxed ${msg.role === "brand_agent" ? "bg-blue-50 border border-blue-200" : "bg-gray-50 border border-gray-200"}`}>
                    <p className={`text-[8px] font-semibold uppercase mb-0.5 ${msg.role === "brand_agent" ? "text-blue-600" : "text-gray-500"}`}>
                      {msg.role === "brand_agent" ? "Alex (Brand)" : detail.supplierName ?? "Supplier"}
                    </p>
                    <p className="text-gray-700 whitespace-pre-wrap text-[10px]">{msg.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Round Changes (wins & losses vs previous round) */}
        {detail.round?.offerData && detail.prevOffer && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Round Changes</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(() => {
                const curr = detail.round!.offerData!;
                const prev = detail.prevOffer!;
                const costDelta = curr.totalCost - prev.totalCost;
                const leadDelta = curr.leadTimeDays - prev.leadTimeDays;
                const termsChanged = curr.paymentTerms !== prev.paymentTerms;
                const items: { label: string; from: string; to: string; isWin: boolean }[] = [];
                if (costDelta !== 0) items.push({ label: "Cost", from: `$${prev.totalCost.toLocaleString()}`, to: `$${curr.totalCost.toLocaleString()}`, isWin: costDelta < 0 });
                if (leadDelta !== 0) items.push({ label: "Lead Time", from: `${prev.leadTimeDays}d`, to: `${curr.leadTimeDays}d`, isWin: leadDelta < 0 });
                if (termsChanged) items.push({ label: "Terms", from: prev.paymentTerms, to: curr.paymentTerms, isWin: false });
                if (curr.concessions.length > prev.concessions.length) {
                  const newConcessions = curr.concessions.filter(c => !prev.concessions.includes(c));
                  if (newConcessions.length > 0) items.push({ label: "New Concessions", from: "—", to: newConcessions.join(", "), isWin: true });
                }
                return items.map((item, i) => (
                  <div key={i} className={`rounded px-2.5 py-1.5 border ${item.isWin ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"}`}>
                    <div className="flex items-center gap-1 mb-0.5">
                      <span className={`text-[8px] font-bold ${item.isWin ? "text-green-600" : "text-red-600"}`}>{item.isWin ? "WIN" : "LOSS"}</span>
                      <span className="text-[8px] font-medium text-gray-500 uppercase">{item.label}</span>
                    </div>
                    <p className="text-[9px] text-gray-600"><span className="line-through opacity-60">{item.from}</span> → <span className="font-semibold text-gray-800">{item.to}</span></p>
                  </div>
                ));
              })()}
            </div>
          </div>
        )}

        {/* Offer as table */}
        {detail.round?.offerData && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Extracted Offer</p>
            <div className="bg-green-50 border border-green-200 rounded px-3 py-2 space-y-1.5">
              <div className="grid grid-cols-3 gap-1.5 text-center">
                <div>
                  <p className="text-[8px] text-gray-400 uppercase">Total</p>
                  <p className="text-sm font-bold text-gray-900">${detail.round.offerData.totalCost.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[8px] text-gray-400 uppercase">Lead</p>
                  <p className="text-sm font-bold text-gray-900">{detail.round.offerData.leadTimeDays}d</p>
                </div>
                <div>
                  <p className="text-[8px] text-gray-400 uppercase">Terms</p>
                  <p className="text-sm font-bold text-gray-900">{detail.round.offerData.paymentTerms}</p>
                </div>
              </div>
              {detail.round.offerData.concessions.length > 0 && (
                <div className="pt-1 border-t border-green-200">
                  <p className="text-[8px] text-gray-500 uppercase mb-0.5">Concessions</p>
                  {detail.round.offerData.concessions.map((c, i) => <p key={i} className="text-[9px] text-green-800">+ {c}</p>)}
                </div>
              )}
              {detail.round.offerData.items.length > 0 && (() => {
                const prevItems = new Map<string, { unitPrice: number; quantity: number }>();
                if (detail.prevOffer?.items) {
                  for (const item of detail.prevOffer.items) {
                    prevItems.set(item.sku, { unitPrice: item.unitPrice, quantity: item.quantity });
                  }
                }
                const hasPrev = prevItems.size > 0;
                return (
                  <div className="pt-1 border-t border-green-200">
                    <p className="text-[8px] text-gray-500 uppercase mb-0.5">Per-SKU Breakdown</p>
                    <table className="w-full text-[9px] border-collapse">
                      <thead>
                        <tr className="border-b border-green-200">
                          <th className="text-left py-0.5 px-1 font-medium text-gray-500">SKU</th>
                          <th className="text-right py-0.5 px-1 font-medium text-gray-500">Unit $</th>
                          <th className="text-right py-0.5 px-1 font-medium text-gray-500">Qty</th>
                          <th className="text-right py-0.5 px-1 font-medium text-gray-500">Total</th>
                          {hasPrev && <th className="text-right py-0.5 px-1 font-medium text-gray-500">Change</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {detail.round.offerData.items.map((item, i) => {
                          const prev = prevItems.get(item.sku);
                          const unitDelta = prev ? item.unitPrice - prev.unitPrice : null;
                          return (
                            <tr key={i} className="border-b border-green-100">
                              <td className="py-0.5 px-1 font-mono text-gray-700">{item.sku}</td>
                              <td className="text-right py-0.5 px-1 text-gray-600">${item.unitPrice.toFixed(2)}</td>
                              <td className="text-right py-0.5 px-1 text-gray-600">{item.quantity}</td>
                              <td className="text-right py-0.5 px-1 text-gray-800 font-medium">${(item.unitPrice * item.quantity).toLocaleString()}</td>
                              {hasPrev && (
                                <td className={`text-right py-0.5 px-1 font-semibold ${
                                  unitDelta === null ? "text-gray-300"
                                  : unitDelta < 0 ? "text-green-600"
                                  : unitDelta > 0 ? "text-red-500"
                                  : "text-gray-400"
                                }`}>
                                  {unitDelta === null ? "new"
                                   : unitDelta === 0 ? "—"
                                   : `${unitDelta < 0 ? "\u2193" : "\u2191"}$${Math.abs(unitDelta).toFixed(2)}`}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Strategy detail */}
        {detail.strategy && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Strategy Detail</p>
            <div className="space-y-2">
              <div className="bg-gray-50 border border-gray-200 rounded px-3 py-2">
                <SimpleMarkdown text={detail.strategy.description} />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="bg-green-50 border border-green-200 rounded px-2.5 py-1.5">
                  <p className="text-[8px] font-semibold text-green-700 uppercase mb-0.5">Pros</p>
                  {detail.strategy.pros.map((pr, i) => <p key={i} className="text-[9px] text-green-800">+ {pr}</p>)}
                </div>
                <div className="bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                  <p className="text-[8px] font-semibold text-red-700 uppercase mb-0.5">Cons</p>
                  {detail.strategy.cons.map((c, i) => <p key={i} className="text-[9px] text-red-800">- {c}</p>)}
                </div>
              </div>
              <div>
                <p className="text-[9px] font-semibold text-gray-500 mb-1">Allocations</p>
                {detail.strategy.suppliers.map((s, i) => (
                  <div key={i} className="flex items-center justify-between text-[10px] text-gray-700 py-0.5">
                    <span>{s.supplierName}</span>
                    <span className="font-medium">{s.allocationPct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Decision data */}
        {detail.decisionData && (() => {
          const dd = detail.decisionData;
          const modeLabel = detail.mode ?? "balanced";
          const weightedDims = new Set<string>();
          if (modeLabel.includes("cost") || modeLabel.includes("price")) { weightedDims.add("price"); weightedDims.add("cashFlow"); }
          if (modeLabel.includes("quality")) weightedDims.add("quality");
          if (modeLabel.includes("lead") || modeLabel.includes("speed") || modeLabel.includes("deadline")) weightedDims.add("leadTime");
          if (modeLabel.includes("risk")) weightedDims.add("risk");
          const dimLabels: Record<string, string> = { price: "Price", quality: "Quality", leadTime: "Lead Time", cashFlow: "Cash Flow", risk: "Risk" };
          const dimColors: Record<string, { bg: string; border: string; text: string; badge: string }> = {
            price: { bg: "bg-green-50", border: "border-green-200", text: "text-green-800", badge: "bg-green-100 text-green-700" },
            quality: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-800", badge: "bg-blue-100 text-blue-700" },
            leadTime: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-800", badge: "bg-amber-100 text-amber-700" },
            cashFlow: { bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-800", badge: "bg-purple-100 text-purple-700" },
            risk: { bg: "bg-red-50", border: "border-red-200", text: "text-red-800", badge: "bg-red-100 text-red-700" },
          };

          // Find the supplier being expanded (if any) for the inline drawer
          const expandedSupplierData = expandedSupplier && detail.negotiation
            ? detail.negotiation.suppliers.find(s => s.supplierId === expandedSupplier)
            : null;

          return (
          <div className="space-y-3">
            {/* User Constraints */}
            {detail.userNotes && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-[8px] font-bold text-indigo-600 uppercase tracking-wider">User Constraints</span>
                  <span className="text-[7px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-600 font-medium">Weighted</span>
                </div>
                <p className="text-[10px] text-indigo-900 leading-relaxed italic">&ldquo;{detail.userNotes}&rdquo;</p>
                <p className="text-[8px] text-indigo-500 mt-1">Mode: <span className="font-semibold">{modeLabel}</span></p>
              </div>
            )}

            {/* Executive Summary */}
            <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">
              <p className="text-[8px] font-bold text-green-700 uppercase tracking-wider mb-1">Executive Summary</p>
              <p className="text-[10px] text-green-900 leading-relaxed">{dd.summary}</p>
            </div>

            {/* Recommendation */}
            <div>
              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Recommendation</p>
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-bold text-gray-900">{dd.recommendation.primarySupplierName}</span>
                  {dd.recommendation.splitOrder && (
                    <span className="text-[8px] font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Split Order</span>
                  )}
                </div>
                <div className="space-y-1">
                  {dd.recommendation.allocations.map((alloc, i) => {
                    const params = detail.supplierParams?.get(alloc.supplierId);
                    return (
                      <button
                        key={i}
                        onClick={() => setExpandedSupplier(expandedSupplier === alloc.supplierId ? null : alloc.supplierId)}
                        className="w-full flex items-center justify-between text-[10px] text-gray-700 bg-white rounded-lg px-2.5 py-1.5 border border-gray-100 hover:border-gray-300 hover:bg-gray-50 transition-all cursor-pointer text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{alloc.supplierName}</span>
                          {params && (
                            <span className="text-[8px] text-gray-400">
                              Q:{params.quality} · {params.priceLevel}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2.5 tabular-nums">
                          <span className="font-bold text-gray-900">{alloc.allocationPct}%</span>
                          <span className="text-gray-500">${alloc.agreedCost.toLocaleString()}</span>
                          <span className="text-gray-400">{alloc.leadTimeDays}d</span>
                          <span className="text-[8px] text-gray-400">{alloc.paymentTerms}</span>
                          <span className="text-gray-300 text-[10px]">{expandedSupplier === alloc.supplierId ? "▼" : "▶"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Inline Supplier Drawer */}
            {expandedSupplierData && (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden shadow-sm">
                <div className="bg-gray-50 border-b border-gray-200 px-3 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold text-gray-800">{expandedSupplierData.supplierName}</span>
                    <span className="text-[8px] text-gray-500 font-mono">{expandedSupplierData.supplierCode}</span>
                    {detail.supplierParams?.get(expandedSupplierData.supplierId) && (() => {
                      const p = detail.supplierParams!.get(expandedSupplierData.supplierId)!;
                      return (
                        <span className="text-[8px] text-gray-400">
                          Quality {p.quality}/5 · {p.priceLevel} · {p.leadTime}d · {p.terms}
                        </span>
                      );
                    })()}
                  </div>
                  <button onClick={() => setExpandedSupplier(null)} className="text-[10px] text-gray-400 hover:text-gray-600">Close</button>
                </div>
                {/* Round Summary */}
                <div className="px-3 py-2 border-t border-gray-100">
                  <p className="text-[8px] font-semibold text-gray-500 uppercase mb-1.5">{expandedSupplierData.rounds.length} Rounds</p>
                  <div className="space-y-1">
                    {expandedSupplierData.rounds.map((round, ri) => (
                      <div key={ri} className={`text-[9px] rounded px-2 py-1.5 border ${round.phase === "post_curveball" ? "bg-amber-50 border-amber-100" : "bg-gray-50 border-gray-100"}`}>
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-gray-700">
                            {round.phase === "post_curveball" ? "Post-CB " : ""}R{round.roundNumber}
                          </span>
                          {round.offerData && (
                            <div className="flex items-center gap-2 tabular-nums text-gray-600">
                              <span className="font-semibold">${round.offerData.totalCost.toLocaleString()}</span>
                              <span>{round.offerData.leadTimeDays}d</span>
                              <span className="text-gray-400">{round.offerData.paymentTerms}</span>
                            </div>
                          )}
                        </div>
                        {round.offerData?.concessions && round.offerData.concessions.length > 0 && (
                          <p className="text-[8px] text-green-600 mt-0.5">+ {round.offerData.concessions.join(", ")}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Per-Supplier Pillar Insights */}
            {detail.supplierPillarInsights && Object.keys(detail.supplierPillarInsights).length > 0 && (
              <div>
                <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Pillar Analysis (Latest Round)</p>
                <div className="space-y-2">
                  {detail.negotiation?.suppliers.map((supplier) => {
                    const insights = detail.supplierPillarInsights?.[supplier.supplierId];
                    if (!insights || Object.keys(insights).length === 0) return null;
                    const pillarColors: Record<string, string> = { negotiator: "bg-blue-50 border-blue-200 text-blue-800", riskAnalyst: "bg-amber-50 border-amber-200 text-amber-800", productCost: "bg-green-50 border-green-200 text-green-800" };
                    const pillarLabels: Record<string, string> = { negotiator: "Negotiator", riskAnalyst: "Risk Analyst", productCost: "Product/Cost" };
                    return (
                      <details key={supplier.supplierId} className="border border-gray-200 rounded-lg overflow-hidden">
                        <summary className="text-[9px] font-semibold text-gray-700 cursor-pointer hover:bg-gray-50 px-3 py-1.5 flex items-center gap-2">
                          <span>{supplier.supplierName}</span>
                          <span className="text-[8px] text-gray-400 font-mono">{supplier.supplierCode}</span>
                          <span className="text-[8px] text-gray-400 font-normal">{Object.keys(insights).length} pillars</span>
                        </summary>
                        <div className="px-3 py-2 space-y-1.5 bg-gray-50/50">
                          {Object.entries(insights).map(([pillar, output]) => (
                            <div key={pillar} className={`border rounded px-2.5 py-1.5 ${pillarColors[pillar] ?? "bg-gray-50 border-gray-200 text-gray-800"}`}>
                              <p className="text-[8px] font-bold uppercase mb-0.5">{pillarLabels[pillar] ?? pillar}</p>
                              <SimpleMarkdown text={output} className="text-[9px]" />
                            </div>
                          ))}
                        </div>
                      </details>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Supplier Comparison — with quality info */}
            {dd.comparison.length > 0 && (
              <div>
                <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Score Breakdown</p>
                <div className="space-y-1.5">
                  {[...dd.comparison].sort((a, b) => b.totalScore - a.totalScore).map((score, i) => {
                    const isWinner = i === 0;
                    const params = detail.supplierParams?.get(score.supplierId);
                    const dims = [
                      { key: "price", label: "Cost", value: score.costScore },
                      { key: "quality", label: "Quality", value: score.qualityScore },
                      { key: "leadTime", label: "Lead", value: score.leadTimeScore },
                      { key: "cashFlow", label: "Terms", value: score.termsScore },
                    ];
                    return (
                      <button
                        key={i}
                        onClick={() => setExpandedSupplier(expandedSupplier === score.supplierId ? null : score.supplierId)}
                        className={`w-full rounded-lg border px-3 py-2 text-left transition-all cursor-pointer hover:shadow-sm ${isWinner ? "bg-green-50 border-green-200" : "bg-white border-gray-200 hover:border-gray-300"}`}
                      >
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-2">
                            {isWinner && <span className="text-[7px] font-bold bg-green-600 text-white px-1.5 py-0.5 rounded-full uppercase">Best</span>}
                            <span className="text-[10px] font-bold text-gray-900">{score.supplierName}</span>
                            {params && (
                              <span className="text-[8px] text-gray-400 font-normal">
                                Q:{params.quality}/5 · {params.priceLevel}
                              </span>
                            )}
                          </div>
                          <span className={`text-sm font-bold tabular-nums ${isWinner ? "text-green-700" : "text-gray-700"}`}>{score.totalScore}</span>
                        </div>
                        <div className="flex gap-1.5">
                          {dims.map((dim) => {
                            const isWeighted = weightedDims.has(dim.key);
                            const c = dimColors[dim.key] ?? dimColors.price;
                            return (
                              <div
                                key={dim.key}
                                className={`flex-1 rounded px-1.5 py-1 text-center ${c.bg} border ${c.border} ${isWeighted ? "ring-1 ring-offset-1 ring-indigo-300" : ""}`}
                              >
                                <p className="text-[7px] font-semibold uppercase text-gray-500 flex items-center justify-center gap-0.5">
                                  {dim.label}
                                  {isWeighted && <span className="text-indigo-500">★</span>}
                                </p>
                                <p className={`text-[10px] font-bold ${c.text}`}>{dim.value}</p>
                              </div>
                            );
                          })}
                        </div>
                      </button>
                    );
                  })}
                </div>
                {weightedDims.size > 0 && (
                  <p className="text-[7px] text-indigo-500 mt-1 flex items-center gap-1">
                    <span>★</span> Weighted by user constraints
                  </p>
                )}
              </div>
            )}

            {/* Key Points — as dimension cards */}
            {dd.keyPoints.length > 0 && (
              <div>
                <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Key Points</p>
                <div className="grid grid-cols-1 gap-1.5">
                  {dd.keyPoints.map((kp, i) => {
                    const c = dimColors[kp.dimension] ?? dimColors.price;
                    const isWeighted = weightedDims.has(kp.dimension);
                    return (
                      <div key={i} className={`rounded-lg px-3 py-2 border ${c.bg} ${c.border} ${isWeighted ? "ring-1 ring-offset-1 ring-indigo-300" : ""}`}>
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[8px] font-bold uppercase ${c.text}`}>{dimLabels[kp.dimension] ?? kp.dimension}</span>
                            {isWeighted && <span className="text-[7px] px-1 py-0.5 rounded-full bg-indigo-100 text-indigo-600 font-medium">★ Weighted</span>}
                          </div>
                          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full ${c.badge}`}>{kp.winner}</span>
                        </div>
                        <p className="text-[9px] text-gray-700 leading-relaxed">{kp.verdict}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tradeoffs — styled cards */}
            <div>
              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Tradeoffs</p>
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                <SimpleMarkdown text={dd.tradeoffs} />
              </div>
            </div>

            {/* Full Reasoning — collapsible */}
            <details>
              <summary className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-600 flex items-center gap-1">
                <span>Full Analysis</span>
                <span className="text-[7px] font-normal text-gray-300">(click to expand)</span>
              </summary>
              <div className="mt-1.5 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5">
                <SimpleMarkdown text={dd.reasoning} />
              </div>
            </details>
          </div>
          );
        })()}

        {/* Pillar output (from pillar node click — rendered as markdown) */}
        {detail.pillarOutput && (
          <div>
            <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Analysis</p>
            <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2">
              <SimpleMarkdown text={detail.pillarOutput} />
            </div>
          </div>
        )}

        {/* Generic fallback */}
        {!detail.round && !detail.pillarOutput && !detail.strategy && !detail.contextSummary && !detail.contextSections && !detail.decisionData && (
          <div className="text-center py-6">
            <p className="text-[10px] text-gray-400">
              {detail.type === "userPriorities" ? "User-defined priorities that guide the negotiation strategy." :
               detail.type === "phase" ? "Pipeline processing phase." :
               detail.type === "decision" ? "Best choice over tradeoffs → purchase order recommendation." :
               detail.type === "curveball" ? "Mid-negotiation disruption triggering strategy re-evaluation." :
               "Click a round node for full conversation details."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface OrchestrationFlowProps {
  negotiation: NegotiationResponse;
  activePillars?: Record<string, string>;
  isLive?: boolean;
  liveEvents?: SSEEvent[];
}

export function OrchestrationFlow({ negotiation, activePillars, isLive, liveEvents }: OrchestrationFlowProps) {
  const [selectedDetail, setSelectedDetail] = useState<NodeDetail | null>(null);

  // Compute live state from events
  const liveState = useMemo((): LiveState | undefined => {
    if (!isLive && !liveEvents?.length) return undefined;

    const activeSuppliers = new Set<string>();
    const activeRounds = new Set<string>();
    const contextSummaries = new Map<string, string>();
    const contextData = new Map<string, ContextSections>();
    const pillarOutputs = new Map<string, string>();
    const supplierParamsMap = new Map<string, SupplierParams>();
    const revealedSteps = new Set<string>();
    let curveballAnalysis: CurveballAnalysis | undefined = undefined;
    let activeStep: string | undefined;
    let negotiationStartTime: number | undefined;
    let latestScoredOffers: ScoredOffer[] = [];

    if (liveEvents) {
      for (const event of liveEvents) {
        if (event.type === "negotiation_started") {
          negotiationStartTime = event.timestamp;
          revealedSteps.add("negotiation_started");
        }
        if (event.type === "supplier_started") {
          supplierParamsMap.set(event.supplierId, {
            quality: event.quality,
            priceLevel: event.priceLevel,
            leadTime: event.leadTime,
            terms: event.terms,
          });
          revealedSteps.add(`supplier-${event.supplierId}`);
        }
        if (event.type === "supplier_waiting") {
          activeSuppliers.add(event.supplierId);
          activeStep = `${event.supplierName} waiting — ${event.reason}`;
          revealedSteps.add(`supplier-waiting-${event.supplierId}`);
        }
        if (event.type === "round_start") {
          activeRounds.add(`${event.supplierId}-${event.roundNumber}`);
          activeSuppliers.add(event.supplierId);
          activeStep = `Round ${event.roundNumber} → ${event.supplierId}`;
          revealedSteps.add(`round-${event.supplierId}-${event.roundNumber}`);
        }
        if (event.type === "round_end") {
          activeRounds.delete(`${event.supplierId}-${event.roundNumber}`);
        }
        if (event.type === "supplier_complete") {
          activeSuppliers.delete(event.supplierId);
        }
        if (event.type === "context_built") {
          contextSummaries.set(`${event.supplierId}-${event.roundNumber}`, event.summary);
          if (event.sections) {
            contextData.set(`${event.supplierId}-${event.roundNumber}`, event.sections);
          }
          activeStep = `Context built for ${event.supplierId}`;
        }
        if (event.type === "pillar_started") {
          activeStep = `${event.pillar} pillar analyzing (R${event.roundNumber})`;
        }
        if (event.type === "pillar_complete") {
          if (event.output) {
            pillarOutputs.set(`${event.supplierId}-${event.roundNumber}-${event.pillar}`, event.output);
          }
        }
        if (event.type === "offers_snapshot") {
          latestScoredOffers = event.offers;
        }
        if (event.type === "curveball_detected") {
          activeStep = `[CURVEBALL] Disruption: ${event.description}`;
          revealedSteps.add("curveball");
        }
        if (event.type === "curveball_analysis") {
          curveballAnalysis = event.analysis;
          activeStep = `Curveball analysis complete — ${event.analysis.strategies.length} strategies`;
        }
        if (event.type === "message") {
          activeStep = `${event.role === "brand_agent" ? "Alex" : event.supplierName} speaking (R${event.roundNumber})`;
        }
      }
    }

    return {
      activePillars: activePillars ?? {},
      activeSuppliers,
      activeRounds,
      contextSummaries,
      contextData,
      pillarOutputs,
      supplierParams: supplierParamsMap,
      scoredOffers: latestScoredOffers,
      curveballAnalysis,
      activeStep,
      negotiationStartTime,
      revealedSteps,
    };
  }, [isLive, liveEvents, activePillars]);

  const { nodes, edges, roundMap } = useMemo(
    () => buildGraph(negotiation, liveState),
    [negotiation, liveState],
  );

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    if (node.type === "round") {
      const round = roundMap.get(node.id);
      const supplier = negotiation.suppliers.find(s => node.id.includes(s.supplierId));
      const ctxKey = round ? `${supplier?.supplierId}-${round.roundNumber}` : "";

      // Gather pillar insights and structured context for this round
      // Priority: live SSE state > persisted offerData._* fields
      const pillarInsights: Record<string, string> = {};
      let contextSections: ContextSections | undefined;
      let contextSummary: string | undefined;

      if (liveState) {
        for (const pk of ["negotiator", "riskAnalyst", "productCost"]) {
          const output = liveState.pillarOutputs.get(`${ctxKey}-${pk}`);
          if (output) pillarInsights[pk] = output;
        }
        contextSections = liveState.contextData.get(ctxKey);
        contextSummary = liveState.contextSummaries.get(ctxKey);
      }

      // Fallback to persisted data from offerData JSON
      if (!contextSections && round?.offerData?._contextSections) {
        contextSections = round.offerData._contextSections;
      }
      if (!contextSummary && round?.offerData?._contextSummary) {
        contextSummary = round.offerData._contextSummary;
      }
      if (Object.keys(pillarInsights).length === 0 && round?.offerData?._pillarOutputs) {
        for (const [pk, output] of Object.entries(round.offerData._pillarOutputs)) {
          pillarInsights[pk] = output;
        }
      }

      if (round) {
        // Find previous round's offer for delta display
        const supplierRounds = supplier?.rounds.filter(r => r.phase === round.phase) ?? [];
        const roundIdx = supplierRounds.findIndex(r => r.roundNumber === round.roundNumber);
        const prevRoundOffer = roundIdx > 0 ? supplierRounds[roundIdx - 1]?.offerData : null;

        setSelectedDetail({
          id: node.id, type: "round",
          title: `${round.phase === "post_curveball" ? "Post-CB " : ""}Round ${round.roundNumber}`,
          subtitle: supplier?.supplierName,
          round, supplierName: supplier?.supplierName,
          prevOffer: prevRoundOffer,
          contextSummary,
          contextSections,
          pillarInsights: Object.keys(pillarInsights).length > 0 ? pillarInsights : undefined,
          scoredOffers: liveState?.scoredOffers,
          metadata: {
            Phase: round.phase, Status: round.status, Messages: round.messages.length,
            ...(round.offerData ? { "Total Cost": `$${round.offerData.totalCost.toLocaleString()}`, "Lead Time": `${round.offerData.leadTimeDays}d`, Terms: round.offerData.paymentTerms } : {}),
          },
        });
        return;
      }
    }

    if (node.type === "supplier") {
      const supplier = negotiation.suppliers.find(s => node.id.includes(s.supplierId));
      if (supplier) {
        const lastRound = supplier.rounds[supplier.rounds.length - 1];
        setSelectedDetail({ id: node.id, type: "supplier", title: supplier.supplierName, subtitle: supplier.supplierCode,
          metadata: { Rounds: supplier.rounds.length, ...(lastRound?.offerData ? { "Latest Offer": `$${lastRound.offerData.totalCost.toLocaleString()}`, "Lead Time": `${lastRound.offerData.leadTimeDays}d`, Terms: lastRound.offerData.paymentTerms } : {}) },
        });
        return;
      }
    }

    if (node.type === "pillar") {
      const pillarId = node.id.replace("pillar-", "");
      const labels: Record<string, string> = { negotiator: "Negotiation Specialist", riskAnalyst: "Risk Analyst", productCost: "Product & Cost" };
      let latestOutput: string | undefined;
      if (liveEvents) {
        for (let i = liveEvents.length - 1; i >= 0; i--) {
          const e = liveEvents[i];
          if (e.type === "pillar_complete" && e.pillar === pillarId && e.output) {
            latestOutput = e.output;
            break;
          }
        }
      }
      setSelectedDetail({ id: node.id, type: "pillar", title: labels[pillarId] ?? pillarId, subtitle: "Brand Agent Pillar", pillarName: pillarId, pillarOutput: latestOutput ?? "No output yet.", metadata: { Status: (node.data as { status?: string }).status ?? "pending" } });
      return;
    }

    if (node.type === "strategy") {
      const strategy = (node.data as { strategy: CurveballStrategy }).strategy;
      setSelectedDetail({ id: node.id, type: "strategy", title: strategy.name, subtitle: "Curveball Strategy", strategy, metadata: { "Est. Cost": `$${(strategy.estimatedCost / 1000).toFixed(1)}K`, Suppliers: strategy.suppliers.length } });
      return;
    }

    if (node.type === "userPriorities") {
      setSelectedDetail({ id: node.id, type: "userPriorities", title: "User Priorities",
        subtitle: negotiation.mode ? `Mode: ${negotiation.mode}` : undefined,
        metadata: { Mode: negotiation.mode ?? "balanced" },
        contextSummary: negotiation.userNotes ?? "No specific priorities set by user.",
      });
      return;
    }

    if (node.id === "decision") {
      // Extract latest pillar outputs per supplier from round offerData
      const supplierPillarInsights: Record<string, Record<string, string>> = {};
      for (const supplier of negotiation.suppliers) {
        // Walk rounds in reverse to find the latest pillar data
        for (let ri = supplier.rounds.length - 1; ri >= 0; ri--) {
          const pillars = supplier.rounds[ri].offerData?._pillarOutputs;
          if (pillars && Object.keys(pillars).length > 0) {
            supplierPillarInsights[supplier.supplierId] = pillars;
            break;
          }
        }
        // Fallback to liveState if no persisted data
        if (!supplierPillarInsights[supplier.supplierId] && liveState) {
          const lastRound = supplier.rounds[supplier.rounds.length - 1];
          if (lastRound) {
            const ctxKey = `${supplier.supplierId}-${lastRound.roundNumber}`;
            const insights: Record<string, string> = {};
            for (const pk of ["negotiator", "riskAnalyst", "productCost"]) {
              const output = liveState.pillarOutputs.get(`${ctxKey}-${pk}`);
              if (output) insights[pk] = output;
            }
            if (Object.keys(insights).length > 0) {
              supplierPillarInsights[supplier.supplierId] = insights;
            }
          }
        }
      }

      // Show loading state immediately, then fetch decision data
      setSelectedDetail({
        id: "decision", type: "decision", title: "Final Decision",
        subtitle: negotiation.status === "completed" ? "Completed" : "Pending...",
        metadata: { Status: negotiation.status },
        supplierParams: liveState?.supplierParams,
        supplierPillarInsights,
        userNotes: negotiation.userNotes,
        mode: negotiation.mode,
        negotiation,
      });
      if (negotiation.status === "completed") {
        getDecision(negotiation.negotiationId).then((decision) => {
          if (decision) {
            setSelectedDetail({
              id: "decision", type: "decision", title: "Final Decision",
              subtitle: decision.summary,
              decisionData: decision,
              supplierParams: liveState?.supplierParams,
              supplierPillarInsights,
              userNotes: negotiation.userNotes,
              mode: negotiation.mode,
              negotiation,
              metadata: {
                Status: "completed",
                "Primary Supplier": decision.recommendation.primarySupplierName,
                "Split Order": decision.recommendation.splitOrder ? "Yes" : "No",
                "PO ID": decision.purchaseOrderId.slice(0, 12) + "...",
                ...(negotiation.totalCostUsd ? { "AI Cost": `$${negotiation.totalCostUsd.toFixed(4)}` } : {}),
                ...(negotiation.totalTokens ? { "AI Tokens": negotiation.totalTokens.toLocaleString() } : {}),
              },
      });
    }
  });
      }
      return;
    }

    if (node.id === "parse") {
      const pm = negotiation.parseMetadata;
      if (!pm) return; // No drawer if no parse metadata

      const numSuppliers = negotiation.suppliers.length;
      setSelectedDetail({
        id: node.id, type: "phase", title: "XLSX Parse & Product Match",
        subtitle: pm
          ? `${pm.matchSummary.totalProducts} products from ${pm.sheets.length} sheet(s) in ${pm.timings.totalMs}ms`
          : `${numSuppliers} suppliers`,
        contextSummary: pm
          ? [
              `1. XLSX Read — ${pm.sheets.map(s => `"${s.sheetName}" (${s.rows}x${s.cols})`).join(", ")} [${pm.timings.xlsxReadMs}ms]`,
              `2. LLM Structuring — ${pm.matchSummary.totalRawRows} raw rows extracted [${pm.timings.llmStructureMs}ms]`,
              `3. Validation — Arithmetic ${pm.validation.arithmeticCheckPassed ? "passed (fast path)" : `flagged ${pm.validation.flagCount} issue(s)`} [${pm.timings.validationMs}ms]`,
              `4. Product Matching — ${pm.matchSummary.autoAccepted} auto, ${pm.matchSummary.needsReview} review, ${pm.matchSummary.needsAction} action, ${pm.matchSummary.unmatched} unmatched [${pm.timings.matchingMs}ms]`,
              `5. Supplier — ${pm.supplierExtraction.found ? `"${pm.supplierExtraction.name}" (${pm.supplierExtraction.matched ? "matched" : "new"})` : "not detected"}`,
            ].join("\n")
          : [
              "1. XLSX Parsing — Extract raw items from uploaded spreadsheet",
              "2. Product Matching — Match parsed items against 10K product catalog",
              "3. Human Review — Confirm/correct flagged matches",
              `4. Supplier Creation — ${numSuppliers} suppliers loaded for negotiation`,
            ].join("\n"),
        metadata: pm
          ? {
              "Total Products": pm.matchSummary.totalProducts,
              "Auto-Accepted": pm.matchSummary.autoAccepted,
              "Needs Review": pm.matchSummary.needsReview,
              Unmatched: pm.matchSummary.unmatched,
              "Parse Time": `${pm.timings.totalMs}ms`,
              Sheets: pm.sheets.length,
            }
          : {
              Suppliers: numSuppliers,
              Status: "complete",
            },
      });
      return;
    }

    setSelectedDetail({ id: node.id, type: node.type ?? "unknown", title: (node.data as { label?: string }).label ?? node.id, subtitle: (node.data as { subtitle?: string }).subtitle });
  }, [negotiation, roundMap, liveEvents, liveState]);

  return (
    <div className="w-full h-full relative" style={{ minHeight: 500 }}>
      <ReactFlow
        key={`${negotiation.negotiationId}-${negotiation.suppliers.length}-${negotiation.suppliers.flatMap(s => s.rounds).length}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.1}
        maxZoom={1.5}
        defaultEdgeOptions={{ type: "smoothstep" }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={onNodeClick}
      >
        <Background color="#e5e7eb" gap={20} />
        <Controls position="bottom-right" />
        <MiniMap
          nodeColor={node => {
            if (node.type === "curveball" || node.type === "strategy") return "#f59e0b";
            if (node.type === "decision") return "#16a34a";
            if (node.type === "supplier") return "#4b5563";
            if (node.type === "round") return "#d1d5db";
            if (node.type === "pillar") return "#3b82f6";
            if (node.type === "synthesizer") return "#8b5cf6";
            if (node.type === "userPriorities") return "#6366f1";
            return "#1f2937";
          }}
          position="bottom-left"
        />
      </ReactFlow>

      {selectedDetail && <DetailPanel detail={selectedDetail} onClose={() => setSelectedDetail(null)} />}
    </div>
  );
}
