"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { FinalDecisionData, SupplierScore, KeyPoint, SupplierAllocation, AllocationItem, VolumeTier } from "@/services/api-client";
import { CashFlowInsights } from "./CashFlowInsights";
import { AnimatePresence, motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import { calculateCashFlowCost, formatCurrency } from "@/lib/formatting";

// ─── Dimension config ───────────────────────────────────────────────────────

const DIMENSION_CONFIG = {
  price: { label: "Price", icon: "$", gradient: "from-emerald-500 to-emerald-600", bg: "bg-emerald-50", border: "border-emerald-200/60", text: "text-emerald-700", badge: "bg-emerald-100 text-emerald-800" },
  quality: { label: "Quality", icon: "Q", gradient: "from-blue-500 to-blue-600", bg: "bg-blue-50", border: "border-blue-200/60", text: "text-blue-700", badge: "bg-blue-100 text-blue-800" },
  leadTime: { label: "Lead Time", icon: "T", gradient: "from-amber-500 to-amber-600", bg: "bg-amber-50", border: "border-amber-200/60", text: "text-amber-700", badge: "bg-amber-100 text-amber-800" },
  cashFlow: { label: "Cash Flow", icon: "CF", gradient: "from-violet-500 to-violet-600", bg: "bg-violet-50", border: "border-violet-200/60", text: "text-violet-700", badge: "bg-violet-100 text-violet-800" },
  risk: { label: "Risk", icon: "R", gradient: "from-rose-500 to-rose-600", bg: "bg-rose-50", border: "border-rose-200/60", text: "text-rose-700", badge: "bg-rose-100 text-rose-800" },
} as const;

// ─── Key Point Card (Premium) ───────────────────────────────────────────────

function KeyPointCard({ keyPoint }: { keyPoint: KeyPoint }) {
  const c = DIMENSION_CONFIG[keyPoint.dimension];
  return (
    <div className={`relative overflow-hidden rounded-xl border ${c.border} ${c.bg} p-4`}>
      <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${c.gradient}`} />
      <div className="flex items-start gap-3 mt-1">
        <div className="text-xl">{c.icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <span className={`text-[11px] font-bold uppercase tracking-wider ${c.text}`}>
              {c.label}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${c.badge}`}>
              {keyPoint.winner}
            </span>
          </div>
          <p className="text-[13px] text-gray-700 leading-snug">
            {keyPoint.verdict}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Score Bar ──────────────────────────────────────────────────────────────

function ScoreBar({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 text-right text-[11px] text-gray-400">{label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full bg-gray-700 rounded-full transition-all" style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right text-[11px] font-medium text-gray-600 tabular-nums">{Math.round(value)}</span>
    </div>
  );
}

function SupplierScoreCard({ score }: { score: SupplierScore }) {
  return (
    <div className="rounded-md border border-gray-100 bg-gray-50/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800">{score.supplierName}</span>
        <span className="rounded-full bg-gray-900 px-2.5 py-0.5 text-xs font-semibold text-white tabular-nums">{Math.round(score.totalScore)}</span>
      </div>
      <div className="space-y-1.5">
        <ScoreBar value={score.costScore} label="Cost" />
        <ScoreBar value={score.qualityScore} label="Quality" />
        <ScoreBar value={score.leadTimeScore} label="Lead" />
        <ScoreBar value={score.termsScore} label="Terms" />
      </div>
    </div>
  );
}

// ─── Volume Tier Badge ───────────────────────────────────────────────────────

function VolumeTierBadge({ tiers, currentQty }: { tiers: VolumeTier[]; currentQty: number }) {
  if (!tiers || tiers.length <= 1) return null;
  const activeTier = tiers.find((t) => currentQty >= t.minQty && (t.maxQty === null || currentQty <= t.maxQty));
  const betterTier = tiers.find((t) => t.unitPrice < (activeTier?.unitPrice ?? Infinity) && t.minQty > currentQty);

  return (
    <div className="mt-0.5 space-y-0.5">
      {tiers.map((t, i) => {
        const isActive = t === activeTier;
        const isBetter = t === betterTier;
        return (
          <div
            key={i}
            className={`text-[8px] px-1.5 py-0.5 rounded-full inline-flex items-center gap-1 mr-1 ${
              isActive
                ? "bg-blue-100 text-blue-700 font-semibold"
                : isBetter
                  ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                  : "bg-gray-50 text-gray-400"
            }`}
          >
            {t.minQty}{t.maxQty ? `-${t.maxQty}` : "+"}: ${t.unitPrice.toFixed(2)}
            {isBetter && <span className="text-[7px]">save!</span>}
          </div>
        );
      })}
    </div>
  );
}

// ─── Qty Input (inline stepper) ─────────────────────────────────────────────

function QtyInput({ value, onChange, min }: { value: number; onChange: (v: number) => void; min?: number }) {
  const minQty = min ?? 1;
  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => onChange(Math.max(minQty, value - Math.max(1, Math.round(value * 0.1))))}
        className="w-5 h-5 rounded bg-gray-100 text-gray-500 text-xs hover:bg-gray-200 flex items-center justify-center"
      >-</button>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v) && v >= minQty) onChange(v);
        }}
        className="w-16 text-center text-[11px] tabular-nums border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
      <button
        onClick={() => onChange(value + Math.max(1, Math.round(value * 0.1)))}
        className="w-5 h-5 rounded bg-gray-100 text-gray-500 text-xs hover:bg-gray-200 flex items-center justify-center"
      >+</button>
    </div>
  );
}

// ─── Price for qty given volume tiers ────────────────────────────────────────

function priceForQty(basePrice: number, qty: number, tiers?: VolumeTier[]): number {
  if (!tiers || tiers.length === 0) return basePrice;
  const tier = tiers.find((t) => qty >= t.minQty && (t.maxQty === null || qty <= t.maxQty));
  return tier ? tier.unitPrice : basePrice;
}

// ─── SKU Highlighting: detect SKU references in text, show popover ──────────

function SkuHighlightedText({ text, skuMap }: { text: string; skuMap: Map<string, string> }) {
  const [popover, setPopover] = useState<{ sku: string; desc: string; rect: DOMRect } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Build regex for all known SKUs (case-insensitive, word boundary)
  const skuPattern = useMemo(() => {
    const skus = Array.from(skuMap.keys()).sort((a, b) => b.length - a.length);
    if (skus.length === 0) return null;
    const escaped = skus.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
  }, [skuMap]);

  // Close popover on outside click
  useEffect(() => {
    if (!popover) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopover(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [popover]);

  if (!skuPattern) {
    return <span>{text}</span>;
  }

  // Split text by SKU matches
  const parts: { text: string; isSku: boolean }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(skuPattern.source, skuPattern.flags);
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isSku: false });
    }
    parts.push({ text: match[0], isSku: true });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isSku: false });
  }

  return (
    <span ref={containerRef} className="relative">
      {parts.map((part, i) => {
        if (!part.isSku) return <span key={i}>{part.text}</span>;
        const skuUpper = part.text.toUpperCase();
        const desc = skuMap.get(skuUpper) ?? "";
        return (
          <span
            key={i}
            className="inline-flex items-center px-1 py-0.5 rounded bg-gray-100/80 border border-gray-300/50 backdrop-blur-sm text-gray-800 font-mono font-medium cursor-pointer hover:bg-gray-200/80 transition-colors underline underline-offset-2 decoration-gray-400/60"
            onClick={(e) => {
              const rect = (e.target as HTMLElement).getBoundingClientRect();
              setPopover(popover?.sku === skuUpper ? null : { sku: skuUpper, desc, rect });
            }}
          >
            {part.text}
          </span>
        );
      })}
      {popover && (
        <div
          className="fixed z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl px-3 py-2.5 min-w-[200px] max-w-[320px]"
          style={{ top: popover.rect.bottom + 6, left: popover.rect.left }}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[11px] font-bold text-gray-300">{popover.sku}</span>
          </div>
          <p className="text-[12px] text-gray-400 leading-snug">{popover.desc || "No description available"}</p>
        </div>
      )}
    </span>
  );
}

// ─── Rich Text Renderer (replaces raw markdown) ─────────────────────────────
// Parses markdown-like text into styled React components without raw ## / ** symbols

function RichAnalysis({ text, skuMap }: { text: string; skuMap: Map<string, string> }) {
  if (!text) return null;

  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) { i++; continue; }

    // ## Heading → section card
    if (trimmed.startsWith("## ")) {
      const title = trimmed.slice(3).trim();
      // Collect body lines until next ## or end
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("## ")) {
        bodyLines.push(lines[i]);
        i++;
      }
      const body = bodyLines.join("\n").trim();

      // Determine section color — muted dark palette
      const lowerTitle = title.toLowerCase();
      let color = { bg: "bg-gray-50/60", border: "border-gray-200", titleText: "text-gray-800", accent: "bg-gray-100/80" };
      if (lowerTitle.includes("price") || lowerTitle.includes("cost")) color = { bg: "bg-gray-50/60", border: "border-gray-200", titleText: "text-gray-800", accent: "bg-gray-100/80" };
      else if (lowerTitle.includes("quality")) color = { bg: "bg-gray-50/40", border: "border-gray-200", titleText: "text-gray-800", accent: "bg-gray-100/60" };
      else if (lowerTitle.includes("lead") || lowerTitle.includes("time") || lowerTitle.includes("delivery")) color = { bg: "bg-gray-50/40", border: "border-gray-200", titleText: "text-gray-800", accent: "bg-gray-100/60" };
      else if (lowerTitle.includes("risk") || lowerTitle.includes("verification")) color = { bg: "bg-gray-50/40", border: "border-gray-200", titleText: "text-gray-800", accent: "bg-gray-100/60" };
      else if (lowerTitle.includes("cash") || lowerTitle.includes("payment") || lowerTitle.includes("terms")) color = { bg: "bg-gray-50/40", border: "border-gray-200", titleText: "text-gray-800", accent: "bg-gray-100/60" };
      else if (lowerTitle.includes("recommend") || lowerTitle.includes("conclusion")) color = { bg: "bg-gray-900", border: "border-gray-900", titleText: "text-white", accent: "bg-gray-800" };

      const isDark = lowerTitle.includes("recommend") || lowerTitle.includes("conclusion");

      elements.push(
        <div key={`section-${elements.length}`} className={`rounded-xl border ${color.border} ${color.bg} overflow-hidden`}>
          <div className={`px-4 py-2.5 ${color.accent}`}>
            <h4 className={`text-[13px] font-bold ${color.titleText}`}>{title}</h4>
          </div>
          <div className={`px-4 py-3 ${isDark ? "text-gray-300" : "text-gray-700"}`}>
            <RichParagraphs text={body} skuMap={skuMap} isDark={isDark} />
          </div>
        </div>
      );
      continue;
    }

    // Regular paragraph (no heading) — collect until empty line or heading
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].trim().startsWith("## ")) {
      paraLines.push(lines[i]);
      i++;
    }
    const paraText = paraLines.join("\n").trim();
    if (paraText) {
      elements.push(
        <div key={`para-${elements.length}`} className="text-[13px] text-gray-700 leading-relaxed">
          <RichParagraphs text={paraText} skuMap={skuMap} />
        </div>
      );
    }
  }

  return <div className="space-y-3">{elements}</div>;
}

// Renders inline formatting: **bold**, bullet points, SKU references
function RichParagraphs({ text, skuMap, isDark }: { text: string; skuMap: Map<string, string>; isDark?: boolean }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let bulletGroup: string[] = [];

  const flushBullets = () => {
    if (bulletGroup.length === 0) return;
    elements.push(
      <ul key={`ul-${elements.length}`} className="space-y-1.5 my-2">
        {bulletGroup.map((b, bi) => (
          <li key={bi} className="flex items-start gap-2 text-[13px]">
            <span className={`mt-1.5 h-1.5 w-1.5 rounded-full flex-shrink-0 ${isDark ? "bg-gray-500" : "bg-gray-400"}`} />
            <span className="flex-1"><InlineFormatted text={b} skuMap={skuMap} /></span>
          </li>
        ))}
      </ul>
    );
    bulletGroup = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // Bullet point
    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bulletMatch) {
      bulletGroup.push(bulletMatch[1]);
      continue;
    }
    flushBullets();

    if (!trimmed) continue;

    elements.push(
      <p key={`p-${elements.length}`} className={`text-[13px] leading-relaxed ${isDark ? "text-gray-300" : "text-gray-700"}`}>
        <InlineFormatted text={trimmed} skuMap={skuMap} />
      </p>
    );
  }
  flushBullets();

  return <>{elements}</>;
}

// Handles **bold** and SKU highlighting
function InlineFormatted({ text, skuMap }: { text: string; skuMap: Map<string, string> }) {
  // Split by **bold** markers
  const parts: { text: string; bold: boolean }[] = [];
  const boldRe = /\*\*(.+?)\*\*/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push({ text: text.slice(lastIdx, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    lastIdx = boldRe.lastIndex;
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), bold: false });

  return (
    <>
      {parts.map((p, i) =>
        p.bold ? (
          <strong key={i} className="font-semibold text-gray-900">
            <SkuHighlightedText text={p.text} skuMap={skuMap} />
          </strong>
        ) : (
          <SkuHighlightedText key={i} text={p.text} skuMap={skuMap} />
        )
      )}
    </>
  );
}

// ─── Tradeoff Cards ─────────────────────────────────────────────────────────

function TradeoffCards({ text, skuMap }: { text: string; skuMap: Map<string, string> }) {
  // Parse bullet points into individual tradeoff cards
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const tradeoffs: { text: string; type: "gain" | "sacrifice" | "neutral" }[] = [];

  for (const line of lines) {
    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
    const content = bulletMatch ? bulletMatch[1] : line;
    if (!content || content.startsWith("#")) continue;
    const lower = content.toLowerCase();
    const type = lower.includes("sacrifice") || lower.includes("loss") || lower.includes("risk") || lower.includes("higher") || lower.includes("slower") || lower.includes("longer")
      ? "sacrifice"
      : lower.includes("gain") || lower.includes("save") || lower.includes("win") || lower.includes("better") || lower.includes("lower") || lower.includes("faster")
        ? "gain"
        : "neutral";
    tradeoffs.push({ text: content, type });
  }

  if (tradeoffs.length === 0) {
    return <p className="text-[13px] text-gray-600 leading-relaxed"><InlineFormatted text={text} skuMap={skuMap} /></p>;
  }

  // Group by type: gained → given up → neutral
  const order: Record<string, number> = { gain: 0, sacrifice: 1, neutral: 2 };
  const sorted = [...tradeoffs].sort((a, b) => order[a.type] - order[b.type]);
  const groups = { gain: sorted.filter((t) => t.type === "gain"), sacrifice: sorted.filter((t) => t.type === "sacrifice"), neutral: sorted.filter((t) => t.type === "neutral") };

  const renderGroup = (items: typeof tradeoffs, label: string, icon: string, style: string) => {
    if (items.length === 0) return null;
    return (
      <div className={`rounded-xl border overflow-hidden ${style}`}>
        <div className="px-3 py-2 border-b border-gray-200/40 flex items-center gap-2">
          <span className="text-xs">{icon}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{label}</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-200/60 text-gray-500 font-medium">{items.length}</span>
        </div>
        <div className="divide-y divide-gray-100/60">
          {items.map((t, i) => (
            <div key={i} className="px-3 py-2.5">
              <p className="text-[13px] text-gray-700 leading-snug"><InlineFormatted text={t.text} skuMap={skuMap} /></p>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2.5">
      {renderGroup(groups.gain, "Gained", "↑", "bg-gray-50/80 border-gray-200")}
      {renderGroup(groups.sacrifice, "Given Up", "↓", "bg-gray-50/50 border-gray-200")}
      {renderGroup(groups.neutral, "Considerations", "→", "bg-gray-50/30 border-gray-100")}
    </div>
  );
}

// ─── Cash Flow Comparison Panel ─────────────────────────────────────────────

// ─── Re-Quote Modal ─────────────────────────────────────────────────────────

interface ReQuoteModalProps {
  allocations: SupplierAllocation[];
  qtyOverrides: Record<string, number>;
  baselineQtys: Map<string, number>;
  skuDescMap: Map<string, string>;
  onClose: () => void;
  onStartReQuote: (supplierIds: string[], qtyChanges: Record<string, { from: number; to: number }>) => void;
}

function ReQuoteModal({ allocations, qtyOverrides, baselineQtys, skuDescMap, onClose, onStartReQuote }: ReQuoteModalProps) {
  const [selectedSuppliers, setSelectedSuppliers] = useState<Set<string>>(new Set(allocations.map((a) => a.supplierId)));
  const [viewMode, setViewMode] = useState<"changes" | "full">("changes");

  const qtyChanges = useMemo(() => {
    const changes: Record<string, { from: number; to: number }> = {};
    for (const [sku, newQty] of Object.entries(qtyOverrides)) {
      const oldQty = baselineQtys.get(sku) ?? 0;
      if (newQty !== oldQty) {
        changes[sku] = { from: oldQty, to: newQty };
      }
    }
    return changes;
  }, [qtyOverrides, baselineQtys]);

  // Build per-SKU supplier pricing lookup for the diff view
  const skuSupplierPrices = useMemo(() => {
    const map = new Map<string, Map<string, { oldPrice: number; newPrice: number; supplierName: string }>>();
    for (const alloc of allocations) {
      for (const item of alloc.items ?? []) {
        const sku = item.sku.toUpperCase();
        if (!map.has(sku)) map.set(sku, new Map());
        const oldQty = baselineQtys.get(sku) ?? item.quantity;
        const newQty = qtyOverrides[sku] ?? oldQty;
        const oldPrice = priceForQty(item.unitPrice, oldQty, item.volumeTiers);
        const newPrice = priceForQty(item.unitPrice, newQty, item.volumeTiers);
        map.get(sku)!.set(alloc.supplierId, { oldPrice, newPrice, supplierName: alloc.supplierName });
      }
    }
    return map;
  }, [allocations, qtyOverrides, baselineQtys]);

  const toggleSupplier = (id: string) => {
    setSelectedSuppliers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
    >
      {/* Backdrop — full viewport via portal to document.body */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-md"
        onClick={onClose}
      />
      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl max-w-3xl w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col ring-1 ring-black/5 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <span className="w-8 h-8 rounded-lg bg-gray-900 text-white flex items-center justify-center text-xs font-bold">RQ</span>
                Request Re-Quote
              </h3>
              <p className="text-sm text-gray-500 mt-1">Adjust quantities and select suppliers to re-negotiate</p>
            </div>
            <motion.button
              onClick={onClose}
              whileHover={{ scale: 1.1, rotate: 90 }}
              whileTap={{ scale: 0.9 }}
              className="text-gray-400 hover:text-gray-600 w-8 h-8 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </motion.button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* View toggle */}
          <div className="flex items-center gap-2">
            {(["changes", "full"] as const).map((mode) => (
              <motion.button
                key={mode}
                onClick={() => setViewMode(mode)}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${viewMode === mode ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"}`}
              >
                {mode === "changes" ? "Changes Only" : "Full Comparison"}
              </motion.button>
            ))}
          </div>

          {/* Unified diff: per-SKU with qty + per-supplier pricing */}
          <motion.div
            className="rounded-xl border border-gray-200 overflow-hidden"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="bg-gray-50 px-4 py-2.5 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Quantity & Price Impact</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">{Object.keys(qtyChanges).length} modified</span>
              </div>
              <span className="text-[10px] text-gray-400">{allocations.length} suppliers compared</span>
            </div>
            <div className="divide-y divide-gray-100">
              {Object.entries(qtyChanges).map(([sku, change], idx) => {
                const desc = skuDescMap.get(sku) ?? "";
                const supplierPricing = skuSupplierPrices.get(sku);
                return (
                  <motion.div
                    key={sku}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.05 * idx }}
                  >
                    {/* SKU header row */}
                    <div className="bg-gray-50/50 px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-sm text-gray-800">{sku}</span>
                        {desc && <span className="text-[10px] text-gray-400 truncate max-w-[200px]">{desc}</span>}
                      </div>
                    </div>
                    {/* Before/After rows */}
                    <div className="flex items-stretch">
                      <div className="w-8 flex-shrink-0 bg-red-50 text-red-500 font-bold font-mono text-center flex items-center justify-center border-r border-gray-100">−</div>
                      <div className="flex-1 bg-red-50/20 px-4 py-2 flex items-center justify-between">
                        <span className="text-xs text-red-700 font-mono">Qty <span className="font-bold">{change.from.toLocaleString()}</span></span>
                        <div className="flex items-center gap-3">
                          {supplierPricing && Array.from(supplierPricing.entries()).map(([sid, p]) => (
                            <span key={sid} className="text-[10px] text-red-500 tabular-nums">
                              <span className="text-red-400">{p.supplierName.split(" ")[0]}:</span> ${p.oldPrice.toFixed(2)}/u · {formatCurrency(p.oldPrice * change.from)}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-stretch">
                      <div className="w-8 flex-shrink-0 bg-emerald-50 text-emerald-500 font-bold font-mono text-center flex items-center justify-center border-r border-gray-100">+</div>
                      <div className="flex-1 bg-emerald-50/20 px-4 py-2 flex items-center justify-between">
                        <span className="text-xs text-emerald-700 font-mono">Qty <span className="font-bold">{change.to.toLocaleString()}</span></span>
                        <div className="flex items-center gap-3">
                          {supplierPricing && Array.from(supplierPricing.entries()).map(([sid, p]) => {
                            const priceDelta = p.newPrice - p.oldPrice;
                            return (
                              <span key={sid} className="text-[10px] text-emerald-600 tabular-nums">
                                <span className="text-emerald-500">{p.supplierName.split(" ")[0]}:</span> ${p.newPrice.toFixed(2)}/u · {formatCurrency(p.newPrice * change.to)}
                                {Math.abs(priceDelta) > 0.001 && (
                                  <span className={`ml-1 font-semibold ${priceDelta < 0 ? "text-emerald-600" : "text-red-500"}`}>
                                    ({priceDelta < 0 ? "↓" : "↑"}${Math.abs(priceDelta).toFixed(2)})
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>

          {/* Full comparison if toggled */}
          <AnimatePresence>
            {viewMode === "full" && (
              <motion.div
                className="rounded-xl border border-gray-200 overflow-hidden"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                  <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">All Items — Before → After</span>
                </div>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/30">
                      <th className="text-left py-2 px-3 font-medium text-gray-500">SKU</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-500">Original Qty</th>
                      <th className="text-right py-2 px-3 font-medium text-gray-500">New Qty</th>
                      <th className="text-center py-2 px-3 font-medium text-gray-500">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(baselineQtys.entries()).map(([sku, baseQty]) => {
                      const newQty = qtyOverrides[sku] ?? baseQty;
                      const changed = newQty !== baseQty;
                      const delta = newQty - baseQty;
                      return (
                        <tr key={sku} className={`border-b border-gray-50 ${changed ? "bg-blue-50/30" : ""}`}>
                          <td className="py-1.5 px-3 font-mono font-medium text-gray-700">{sku}</td>
                          <td className={`py-1.5 px-3 text-right tabular-nums ${changed ? "line-through text-gray-400" : "text-gray-700"}`}>{baseQty.toLocaleString()}</td>
                          <td className={`py-1.5 px-3 text-right tabular-nums font-semibold ${changed ? "text-blue-700" : "text-gray-700"}`}>{newQty.toLocaleString()}</td>
                          <td className="py-1.5 px-3 text-center">
                            {changed ? (
                              <span className={`text-[10px] font-semibold ${delta > 0 ? "text-emerald-600" : "text-red-600"}`}>
                                {delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString()}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Supplier selection */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Re-negotiate with</h4>
            <div className="space-y-2">
              {allocations.map((alloc, i) => {
                const isChecked = selectedSuppliers.has(alloc.supplierId);
                return (
                  <motion.button
                    key={alloc.supplierId}
                    onClick={() => toggleSupplier(alloc.supplierId)}
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.99 }}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 + i * 0.05 }}
                    className={`w-full flex items-center justify-between rounded-xl border px-4 py-3.5 transition-all text-left ${
                      isChecked
                        ? "bg-gray-900 border-gray-900 text-white shadow-lg shadow-gray-900/20"
                        : "bg-white border-gray-200 text-gray-700 hover:border-gray-300 hover:shadow-sm"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${isChecked ? "bg-white border-white" : "border-gray-300"}`}>
                        {isChecked && <svg className="w-3 h-3 text-gray-900" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>}
                      </div>
                      <div>
                        <span className="text-sm font-semibold">{alloc.supplierName}</span>
                        <span className={`ml-2 text-xs ${isChecked ? "text-gray-400" : "text-gray-400"}`}>
                          {alloc.paymentTerms} · {alloc.leadTimeDays}d · {formatCurrency(alloc.agreedCost)}
                        </span>
                      </div>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {selectedSuppliers.size} supplier(s) selected · {Object.keys(qtyChanges).length} qty change(s)
          </span>
          <div className="flex items-center gap-2">
            <motion.button
              onClick={onClose}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition-colors rounded-lg hover:bg-gray-100"
            >
              Cancel
            </motion.button>
            <motion.button
              onClick={() => onStartReQuote(Array.from(selectedSuppliers), qtyChanges)}
              disabled={selectedSuppliers.size === 0}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              className="px-5 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-lg shadow-gray-900/20"
            >
              Start Re-Quote →
            </motion.button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Order Preview: Side-by-Side Supplier Comparison ────────────────────────

function OrderPreview({
  allocations,
  selectedSupplierId,
  onRequestReQuote,
}: {
  allocations: SupplierAllocation[];
  selectedSupplierId?: string;
  onRequestReQuote?: (supplierIds: string[], qtyChanges: Record<string, { from: number; to: number }>) => void;
}) {
  const [qtyOverrides, setQtyOverrides] = useState<Record<string, number>>({});
  const [showTiers, setShowTiers] = useState(false);
  const [showReQuoteModal, setShowReQuoteModal] = useState(false);

  // Collect all unique SKUs across all allocations
  const allSkus: string[] = [];
  const skuDescMap = new Map<string, string>();
  const baselineQtyMap = new Map<string, number>();
  for (const alloc of allocations) {
    for (const item of alloc.items ?? []) {
      const key = item.sku.toUpperCase();
      if (!allSkus.includes(key)) {
        allSkus.push(key);
        skuDescMap.set(key, item.description);
        baselineQtyMap.set(key, Math.max(baselineQtyMap.get(key) ?? 0, item.quantity));
      }
    }
  }

  // Build a lookup: sku → supplierId → item
  const lookup = new Map<string, Map<string, AllocationItem>>();
  for (const sku of allSkus) lookup.set(sku, new Map());
  for (const alloc of allocations) {
    for (const item of alloc.items ?? []) {
      lookup.get(item.sku.toUpperCase())?.set(alloc.supplierId, item);
    }
  }

  const hasAnyTiers = allocations.some((a) => a.items?.some((i) => i.volumeTiers && i.volumeTiers.length > 0));

  // Compute adjusted totals per supplier
  const supplierTotals = allocations.map((alloc) => {
    let total = 0;
    for (const sku of allSkus) {
      const item = lookup.get(sku)?.get(alloc.supplierId);
      if (!item) continue;
      const adjQty = qtyOverrides[sku] ?? item.quantity;
      const adjPrice = priceForQty(item.unitPrice, adjQty, item.volumeTiers);
      total += adjPrice * adjQty;
    }
    return total;
  });

  const hasOverrides = Object.keys(qtyOverrides).length > 0;

  return (
    <>
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="p-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Order Preview — Side by Side</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Compare per-SKU pricing across suppliers.
              {hasAnyTiers && " Adjust quantities to see volume-based pricing."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasAnyTiers && (
              <button
                onClick={() => setShowTiers(!showTiers)}
                className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${showTiers ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-gray-50 border-gray-200 text-gray-500 hover:border-gray-300"}`}
              >
                {showTiers ? "Hide Tiers" : "Show Volume Tiers"}
              </button>
            )}
            {hasOverrides && (
              <button
                onClick={() => setQtyOverrides({})}
                className="text-[10px] px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors"
              >
                Reset Qtys
              </button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="text-left py-2.5 px-3 font-semibold text-gray-500 sticky left-0 bg-gray-50/50 min-w-[160px]">SKU</th>
                <th className="text-center py-2.5 px-2 font-semibold text-gray-500 w-[120px]">Qty</th>
                {allocations.map((alloc) => {
                  const isSelected = alloc.supplierId === selectedSupplierId;
                  return (
                    <th key={alloc.supplierId} colSpan={2} className={`text-center py-2.5 px-2 font-semibold border-l border-gray-100 ${isSelected ? "text-gray-900 bg-emerald-50/50" : "text-gray-700"}`}>
                      <div className="flex items-center justify-center gap-1.5">
                        {alloc.supplierName}
                        {isSelected && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[8px] font-bold text-emerald-700">SELECTED</span>}
                      </div>
                      <div className="text-[9px] font-normal text-gray-400 mt-0.5">{alloc.paymentTerms} · {alloc.leadTimeDays}d</div>
                    </th>
                  );
                })}
              </tr>
              <tr className="border-b border-gray-100 bg-gray-50/30 text-[10px] text-gray-400">
                <th className="py-1.5 px-3 text-left sticky left-0 bg-gray-50/30">Description</th>
                <th className="py-1.5 px-2 text-center">Adjust</th>
                {allocations.map((alloc) => {
                  const isSelected = alloc.supplierId === selectedSupplierId;
                  return (
                    <th key={alloc.supplierId} colSpan={2} className={`py-1.5 px-2 border-l border-gray-100 ${isSelected ? "bg-emerald-50/30" : ""}`}>
                      <div className="flex justify-between px-1">
                        <span>Unit</span>
                        <span>Total</span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {allSkus.map((sku) => {
                const desc = skuDescMap.get(sku) ?? "";
                const baseQty = baselineQtyMap.get(sku) ?? 0;
                const adjQty = qtyOverrides[sku] ?? baseQty;
                const isQtyChanged = adjQty !== baseQty;

                const supplierPrices = allocations.map((a) => {
                  const item = lookup.get(sku)?.get(a.supplierId);
                  if (!item) return null;
                  return priceForQty(item.unitPrice, adjQty, item.volumeTiers);
                });
                const validPrices = supplierPrices.filter((p): p is number => p !== null && p < Infinity);
                const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : Infinity;

                return (
                  <tr key={sku} className={`border-b border-gray-50 hover:bg-gray-50/50 ${isQtyChanged ? "bg-blue-50/30" : ""}`}>
                    <td className="py-2 px-3 sticky left-0 bg-white">
                      <div className="font-mono font-medium text-gray-700">{sku}</div>
                      <div className="text-[10px] text-gray-400 truncate max-w-[200px]">{desc}</div>
                    </td>
                    <td className="py-2 px-2 text-center">
                      <QtyInput
                        value={adjQty}
                        onChange={(v) => setQtyOverrides((prev) => ({ ...prev, [sku]: v }))}
                      />
                      {isQtyChanged && (
                        <div className="text-[8px] text-blue-500 mt-0.5">was {baseQty.toLocaleString()}</div>
                      )}
                    </td>
                    {allocations.map((alloc, allocIdx) => {
                      const item = lookup.get(sku)?.get(alloc.supplierId);
                      const adjPrice = supplierPrices[allocIdx];
                      const isCheapest = adjPrice !== null && adjPrice === minPrice && validPrices.filter((p) => p === minPrice).length < validPrices.length;
                      const isSelected = alloc.supplierId === selectedSupplierId;
                      const priceChanged = item && adjPrice !== null && adjPrice !== item.unitPrice;
                      return (
                        <td key={alloc.supplierId} colSpan={2} className={`py-2 px-2 border-l border-gray-100 ${isSelected ? "bg-emerald-50/30" : ""}`}>
                          {item && adjPrice !== null ? (
                            <div>
                              <div className="flex justify-between tabular-nums">
                                <span className={`${isCheapest ? "text-emerald-600 font-semibold" : "text-gray-600"}`}>
                                  ${adjPrice.toFixed(2)}
                                  {priceChanged && (
                                    <span className="text-[8px] text-emerald-500 ml-0.5">(was ${item.unitPrice.toFixed(2)})</span>
                                  )}
                                </span>
                                <span className="text-gray-500">{formatCurrency(adjPrice * adjQty)}</span>
                              </div>
                              {showTiers && item.volumeTiers && item.volumeTiers.length > 0 && (
                                <VolumeTierBadge tiers={item.volumeTiers} currentQty={adjQty} />
                              )}
                            </div>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-200 bg-gray-50/50 font-semibold">
                <td colSpan={2} className="py-2.5 px-3 text-gray-700 sticky left-0 bg-gray-50/50">
                  FOB Subtotal
                  {hasOverrides && <span className="text-[9px] font-normal text-blue-500 ml-1">(adjusted)</span>}
                </td>
                {allocations.map((alloc, i) => {
                  const isSelected = alloc.supplierId === selectedSupplierId;
                  const originalTotal = alloc.agreedCost;
                  const adjustedTotal = supplierTotals[i];
                  const changed = hasOverrides && Math.abs(adjustedTotal - originalTotal) > 0.01;
                  return (
                    <td key={alloc.supplierId} colSpan={2} className={`py-2.5 px-2 text-right tabular-nums border-l border-gray-100 ${isSelected ? "bg-emerald-50/50" : ""}`}>
                      <span className={changed ? "text-blue-700" : "text-gray-800"}>{formatCurrency(adjustedTotal)}</span>
                      {changed && (
                        <div className="text-[8px] text-gray-400">
                          was {formatCurrency(originalTotal)}
                          <span className={`ml-1 font-semibold ${adjustedTotal < originalTotal ? "text-emerald-500" : "text-red-500"}`}>
                            {adjustedTotal < originalTotal ? "↓" : "↑"}{formatCurrency(Math.abs(adjustedTotal - originalTotal))}
                          </span>
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
              <tr className="bg-gray-50/30">
                <td colSpan={2} className="py-2 px-3 text-gray-500 text-[11px] sticky left-0 bg-gray-50/30">PV Impact (8% CoC)</td>
                {allocations.map((alloc, i) => {
                  const total = hasOverrides ? supplierTotals[i] : alloc.agreedCost;
                  const cf = calculateCashFlowCost(total, alloc.paymentTerms, alloc.leadTimeDays);
                  const isAdvantage = cf < 0;
                  const isSelected = alloc.supplierId === selectedSupplierId;
                  return (
                    <td key={alloc.supplierId} colSpan={2} className={`py-2 px-2 text-right tabular-nums text-[11px] font-medium border-l border-gray-100 ${isSelected ? "bg-emerald-50/30" : ""} ${isAdvantage ? "text-emerald-600" : cf > 0 ? "text-amber-600" : "text-gray-500"}`}>
                      {isAdvantage ? `+${formatCurrency(Math.abs(cf))}` : `-${formatCurrency(cf)}`}
                      <span className={`ml-1 text-[9px] font-bold ${isAdvantage ? "text-emerald-500" : "text-amber-500"}`}>{isAdvantage ? "advantage" : "locked"}</span>
                    </td>
                  );
                })}
              </tr>
              <tr className="border-t border-gray-200 bg-white font-bold">
                <td colSpan={2} className="py-2.5 px-3 text-gray-900 sticky left-0 bg-white">Effective Landed</td>
                {allocations.map((alloc, i) => {
                  const total = hasOverrides ? supplierTotals[i] : alloc.agreedCost;
                  const cf = calculateCashFlowCost(total, alloc.paymentTerms, alloc.leadTimeDays);
                  const isSelected = alloc.supplierId === selectedSupplierId;
                  return (
                    <td key={alloc.supplierId} colSpan={2} className={`py-2.5 px-2 text-right tabular-nums text-gray-900 border-l border-gray-100 ${isSelected ? "bg-emerald-50/50" : ""}`}>
                      {formatCurrency(total + cf)}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
        {/* Qty adjustment footer — re-quote disabled */}
        {hasOverrides && (
          <div className="p-3 border-t border-gray-100 bg-blue-50/50">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-blue-700 font-medium">
                {Object.keys(qtyOverrides).length} item(s) adjusted — prices recalculated using negotiated volume tiers
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Re-Quote Comparison ────────────────────────────────────────────────────

function ReQuoteComparison({ preDecision, postDecision }: { preDecision: FinalDecisionData; postDecision: FinalDecisionData }) {
  // ── Build per-SKU price map from allocations (use primary supplier's items) ──
  const buildSkuMap = (decision: FinalDecisionData) => {
    const map = new Map<string, { unitPrice: number; qty: number; desc: string }>();
    const allocs = decision.allSupplierAllocations ?? decision.recommendation.allocations;
    // Use the primary supplier's items first, then fill gaps from others
    const primary = allocs.find((a) => a.supplierId === decision.recommendation.primarySupplierId);
    const sources = primary ? [primary, ...allocs.filter((a) => a !== primary)] : allocs;
    for (const alloc of sources) {
      for (const item of alloc.items ?? []) {
        const key = item.sku.toUpperCase().trim();
        if (!map.has(key)) {
          map.set(key, { unitPrice: item.unitPrice, qty: item.quantity, desc: item.description });
        }
      }
    }
    return map;
  };

  const preSkus = buildSkuMap(preDecision);
  const postSkus = buildSkuMap(postDecision);

  // ── Identify changed SKUs (qty or unit price changed) ──
  type SkuDiff = { sku: string; desc: string; preQty: number; postQty: number; preUnit: number; postUnit: number; preTotal: number; postTotal: number };
  const changed: SkuDiff[] = [];
  const unchanged: SkuDiff[] = [];

  // Use POST skus as the source of truth (these are the re-quoted items)
  const allSkuKeys = new Set([...preSkus.keys(), ...postSkus.keys()]);
  for (const sku of allSkuKeys) {
    const pre = preSkus.get(sku);
    const post = postSkus.get(sku);
    if (!pre && !post) continue;

    const preQty = pre?.qty ?? 0;
    const postQty = post?.qty ?? preQty;
    const preUnit = pre?.unitPrice ?? 0;
    const postUnit = post?.unitPrice ?? preUnit;
    const desc = post?.desc ?? pre?.desc ?? sku;

    const diff: SkuDiff = {
      sku, desc,
      preQty, postQty, preUnit, postUnit,
      preTotal: preUnit * preQty,
      postTotal: postUnit * postQty,
    };

    const qtyChanged = preQty !== postQty;
    const priceChanged = Math.abs(preUnit - postUnit) >= 0.01;
    if (qtyChanged || priceChanged) {
      changed.push(diff);
    } else {
      unchanged.push(diff);
    }
  }

  // ── Normalized totals: same SKUs, compare unit price × qty ──
  // For a fair comparison, compute "what the NEW quantities would cost at OLD prices" vs actual new prices
  const normalizedPreTotal = changed.reduce((s, d) => s + d.preUnit * d.postQty, 0) + unchanged.reduce((s, d) => s + d.preTotal, 0);
  const normalizedPostTotal = changed.reduce((s, d) => s + d.postTotal, 0) + unchanged.reduce((s, d) => s + d.postTotal, 0);
  const normalizedDiff = normalizedPostTotal - normalizedPreTotal;
  const normalizedPct = normalizedPreTotal > 0 ? Math.abs((normalizedDiff / normalizedPreTotal) * 100).toFixed(1) : "0";
  const isBetter = normalizedDiff < 0;
  const isSame = Math.abs(normalizedDiff) < 1;

  // ── Terms comparison ──
  const preSupplier = preDecision.recommendation.primarySupplierName ?? "—";
  const postSupplier = postDecision.recommendation.primarySupplierName ?? "—";
  const supplierChanged = preSupplier !== postSupplier;

  const getWeightedLead = (allocs: typeof preDecision.recommendation.allocations) => {
    const totalPct = allocs.reduce((s, a) => s + a.allocationPct, 0) || 1;
    return Math.round(allocs.reduce((s, a) => s + a.leadTimeDays * (a.allocationPct / totalPct), 0));
  };
  const preLead = getWeightedLead(preDecision.recommendation.allocations);
  const postLead = getWeightedLead(postDecision.recommendation.allocations);
  const preTerms = preDecision.recommendation.allocations[0]?.paymentTerms ?? "—";
  const postTerms = postDecision.recommendation.allocations[0]?.paymentTerms ?? "—";

  return (
    <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-gray-900 p-2 text-white">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">Re-Quote Impact</h3>
              <p className="text-[11px] text-gray-500">
                {changed.length} SKU{changed.length !== 1 ? "s" : ""} changed · {unchanged.length} unchanged · normalized comparison
              </p>
            </div>
          </div>
          <div className={`rounded-full px-3 py-1 text-xs font-semibold ${
            isBetter ? "bg-emerald-100 text-emerald-800" : isSame ? "bg-gray-100 text-gray-600" : "bg-amber-100 text-amber-800"
          }`}>
            {isBetter ? `Saved ${normalizedPct}%` : isSame ? "Neutral" : `+${normalizedPct}% cost`}
          </div>
        </div>
      </div>

      {/* Changed SKUs — per-item breakdown */}
      {changed.length > 0 && (
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">Changed Items</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-[10px] text-gray-400">
                  <th className="text-left py-1.5 font-medium">SKU</th>
                  <th className="text-right py-1.5 font-medium">Qty Before</th>
                  <th className="text-right py-1.5 font-medium">Qty After</th>
                  <th className="text-right py-1.5 font-medium">Unit Before</th>
                  <th className="text-right py-1.5 font-medium">Unit After</th>
                  <th className="text-right py-1.5 font-medium">Unit Price Change</th>
                </tr>
              </thead>
              <tbody>
                {changed.map((d) => {
                  const unitDiff = d.postUnit - d.preUnit;
                  const unitPriceSame = Math.abs(unitDiff) < 0.01;
                  const qtyChanged = d.preQty !== d.postQty;
                  return (
                    <tr key={d.sku} className="border-b border-gray-50">
                      <td className="py-2 font-mono font-medium text-gray-700">
                        <div>{d.sku}</div>
                        <div className="text-[10px] text-gray-400 font-sans truncate max-w-[180px]">{d.desc}</div>
                      </td>
                      <td className={`py-2 text-right tabular-nums ${qtyChanged ? "text-gray-400 line-through" : "text-gray-600"}`}>
                        {d.preQty.toLocaleString()}
                      </td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${qtyChanged ? "text-blue-700" : "text-gray-600"}`}>
                        {d.postQty.toLocaleString()}
                      </td>
                      <td className="py-2 text-right tabular-nums text-gray-500">${d.preUnit.toFixed(2)}</td>
                      <td className="py-2 text-right tabular-nums font-semibold text-gray-900">${d.postUnit.toFixed(2)}</td>
                      <td className={`py-2 text-right tabular-nums font-semibold ${
                        unitPriceSame ? "text-gray-400" : unitDiff < 0 ? "text-emerald-600" : "text-red-500"
                      }`}>
                        {unitPriceSame ? "—" : `${unitDiff < 0 ? "-" : "+"}$${Math.abs(unitDiff).toFixed(2)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Deal terms comparison */}
      <div className="px-5 py-4">
        <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-3">Deal Terms</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="text-[10px] text-gray-400 mb-1">Normalized Cost</div>
            <div className="text-sm font-semibold text-gray-900 tabular-nums">{formatCurrency(normalizedPostTotal)}</div>
            {!isSame && (
              <div className={`text-[10px] font-semibold mt-0.5 ${isBetter ? "text-emerald-600" : "text-red-500"}`}>
                {isBetter ? "-" : "+"}{formatCurrency(Math.abs(normalizedDiff))} vs prior
              </div>
            )}
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="text-[10px] text-gray-400 mb-1">Lead Time</div>
            <div className="text-sm font-semibold text-gray-900">{postLead}d</div>
            {preLead !== postLead && (
              <div className={`text-[10px] font-semibold mt-0.5 ${postLead < preLead ? "text-emerald-600" : "text-red-500"}`}>
                {postLead < preLead ? `-${preLead - postLead}d` : `+${postLead - preLead}d`} vs prior
              </div>
            )}
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="text-[10px] text-gray-400 mb-1">Payment Terms</div>
            <div className="text-sm font-semibold text-gray-900">{postTerms}</div>
            {preTerms !== postTerms && (
              <div className="text-[10px] text-blue-600 font-semibold mt-0.5">was {preTerms}</div>
            )}
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <div className="text-[10px] text-gray-400 mb-1">Primary Supplier</div>
            <div className="text-sm font-semibold text-gray-900 truncate">{postSupplier}</div>
            {supplierChanged && (
              <div className="text-[10px] text-blue-600 font-semibold mt-0.5">was {preSupplier}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

interface FinalDecisionProps {
  decision: FinalDecisionData;
  preReQuoteDecision?: FinalDecisionData | null;
  onRequestReQuote?: (supplierIds: string[], qtyChanges: Record<string, { from: number; to: number }>) => void;
}

export function FinalDecision({ decision, preReQuoteDecision, onRequestReQuote }: FinalDecisionProps) {
  const [showFullReport, setShowFullReport] = useState(false);

  const { recommendation, comparison, reasoning, tradeoffs, summary, keyPoints } = decision;

  // Build SKU → description map for highlighting
  const skuMap = useMemo(() => {
    const map = new Map<string, string>();
    const allocs = decision.allSupplierAllocations ?? recommendation.allocations;
    for (const alloc of allocs) {
      for (const item of alloc.items ?? []) {
        map.set(item.sku.toUpperCase(), item.description);
      }
    }
    return map;
  }, [decision.allSupplierAllocations, recommendation.allocations]);

  const previewAllocations = decision.allSupplierAllocations ?? recommendation.allocations;

  const totalOrderCost = previewAllocations.reduce((sum, a) => sum + a.agreedCost, 0);

  return (
    <div className="space-y-5">
      {/* Order Overview — Split Order Header */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        {/* Header Section */}
        <div className="bg-gradient-to-r from-gray-50 to-white px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-gray-900 p-2">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <div>
                <h2 className="text-base font-bold text-gray-900">
                  {recommendation.splitOrder
                    ? `Recommended: Split Across ${recommendation.allocations.length} Suppliers`
                    : `Recommended: ${recommendation.primarySupplierName}`}
                </h2>
              </div>
            </div>
            {recommendation.splitOrder && (
              <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-1.5">
                <span className="text-xs font-semibold text-blue-700">Multi-Supplier Strategy</span>
              </div>
            )}
          </div>
        </div>

        {/* Allocation Cards */}
        <div className="p-6">
          <div className={`grid gap-4 ${recommendation.allocations.length === 2 ? "grid-cols-2" : recommendation.allocations.length === 3 ? "grid-cols-3" : "grid-cols-1"}`}>
            {recommendation.allocations
              .sort((a, b) => b.allocationPct - a.allocationPct)
              .map((alloc, idx) => {
                const matchedAlloc = previewAllocations.find((pa) => pa.supplierId === alloc.supplierId);
                const itemCount = matchedAlloc?.items?.length ?? 0;
                const isPrimary = alloc.supplierId === recommendation.primarySupplierId;
                return (
                  <div
                    key={alloc.supplierId}
                    className={`rounded-lg border-2 p-4 transition-all ${
                      isPrimary
                        ? "bg-gray-900 border-gray-900 text-white shadow-lg"
                        : "bg-gray-50 border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className={`text-sm font-bold ${isPrimary ? "text-white" : "text-gray-900"}`}>
                            {alloc.supplierName}
                          </h3>
                          {isPrimary && (
                            <span className="text-[10px] font-bold bg-white/20 text-white rounded-full px-2 py-0.5">
                              PRIMARY
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`text-2xl font-bold tabular-nums ${isPrimary ? "text-white" : "text-gray-900"}`}>
                            {alloc.allocationPct}%
                          </span>
                          <span className={`text-xs ${isPrimary ? "text-gray-400" : "text-gray-500"}`}>
                            of order
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2 pt-3 border-t border-white/10">
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${isPrimary ? "text-gray-400" : "text-gray-600"}`}>Order Value</span>
                        <span className={`text-sm font-semibold tabular-nums ${isPrimary ? "text-white" : "text-gray-900"}`}>
                          {formatCurrency(alloc.agreedCost)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${isPrimary ? "text-gray-400" : "text-gray-600"}`}>Lead Time</span>
                        <span className={`text-sm font-medium ${isPrimary ? "text-white" : "text-gray-700"}`}>
                          {alloc.leadTimeDays} days
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className={`text-xs ${isPrimary ? "text-gray-400" : "text-gray-600"}`}>Payment Terms</span>
                        <span className={`text-sm font-medium ${isPrimary ? "text-white" : "text-gray-700"}`}>
                          {alloc.paymentTerms}
                        </span>
                      </div>
                      {itemCount > 0 && (
                        <div className="flex items-center justify-between">
                          <span className={`text-xs ${isPrimary ? "text-gray-400" : "text-gray-600"}`}>SKUs Assigned</span>
                          <span className={`text-sm font-medium ${isPrimary ? "text-white" : "text-gray-700"}`}>
                            {itemCount} items
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      </div>

      {/* Executive Summary + Key Metrics (consolidated) */}
      {summary && (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="rounded-lg bg-gray-900 p-2 text-white text-xs font-bold">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-sm font-bold text-gray-900">Recommendation Overview</h3>
          </div>

          {/* One-line summary */}
          <p className="text-sm text-gray-700 leading-relaxed mb-4">
            {summary}
          </p>

          {/* Key metrics as compact badges */}
          {keyPoints && keyPoints.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {keyPoints.map((kp, i) => {
                const c = DIMENSION_CONFIG[kp.dimension];
                return (
                  <div key={i} className={`rounded-lg border ${c.border} ${c.bg} px-3 py-2 flex items-center gap-2`}>
                    <div className={`rounded ${c.badge} px-1.5 py-0.5 text-[10px] font-bold`}>
                      {c.label}
                    </div>
                    <span className="text-xs font-medium text-gray-700">{kp.winner}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Cash Flow Analysis — selected supplier only */}
      {previewAllocations.length > 0 && (
        <CashFlowInsights allocations={previewAllocations} selectedSupplierId={recommendation.primarySupplierId} />
      )}

      {/* Order Preview — Side-by-Side per SKU (all suppliers) */}
      {previewAllocations.length > 0 && previewAllocations.some((a) => a.items && a.items.length > 0) && (
        <OrderPreview
          allocations={previewAllocations}
          selectedSupplierId={recommendation.primarySupplierId}
        />
      )}

      {/* Full Analysis Report — Custom Components */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <button
          onClick={() => setShowFullReport(!showFullReport)}
          className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 transition-colors"
        >
          <h3 className="text-sm font-semibold text-gray-800">Full Decision Analysis</h3>
          <svg
            className={`w-5 h-5 text-gray-500 transition-transform ${showFullReport ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showFullReport && (
          <div className="px-5 pb-5 space-y-5 border-t border-gray-100 pt-5">
            {/* Gains / Trade-offs with proper markdown rendering */}
            {tradeoffs && (
              <div className="space-y-4">
                {(() => {
                  const lines = tradeoffs.split('\n').map(l => l.trim()).filter(Boolean);
                  const gains: string[] = [];
                  const sacrifices: string[] = [];

                  for (const line of lines) {
                    const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
                    const content = bulletMatch ? bulletMatch[1] : line;
                    if (!content || content.startsWith('#')) continue;

                    const lower = content.toLowerCase();
                    if (lower.includes('gain') || lower.includes('save') || lower.includes('win') || lower.includes('better') || lower.includes('lower') || lower.includes('faster') || lower.includes('premium') || lower.includes('improved')) {
                      gains.push(content);
                    } else if (lower.includes('sacrifice') || lower.includes('loss') || lower.includes('risk') || lower.includes('higher') || lower.includes('slower') || lower.includes('longer') || lower.includes('increase')) {
                      sacrifices.push(content);
                    }
                  }

                  return (
                    <>
                      {gains.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-xs font-bold text-emerald-700 uppercase tracking-wider">Gained</div>
                          <div className="space-y-1.5">
                            {gains.map((gain, i) => (
                              <div key={i} className="flex items-start gap-2 text-sm text-gray-700">
                                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                                <span className="flex-1">
                                  <ReactMarkdown
                                    components={{
                                      strong: ({children}) => <strong className="font-semibold text-gray-900">{children}</strong>,
                                      p: ({children}) => <span>{children}</span>,
                                      em: ({children}) => <em className="italic">{children}</em>,
                                    }}
                                  >
                                    {gain}
                                  </ReactMarkdown>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {sacrifices.length > 0 && (
                        <div className="space-y-2">
                          <div className="text-xs font-bold text-amber-700 uppercase tracking-wider">Trade-offs</div>
                          <div className="space-y-1.5">
                            {sacrifices.map((sacrifice, i) => (
                              <div key={i} className="flex items-start gap-2 text-sm text-gray-700">
                                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                                <span className="flex-1">
                                  <ReactMarkdown
                                    components={{
                                      strong: ({children}) => <strong className="font-semibold text-gray-900">{children}</strong>,
                                      p: ({children}) => <span>{children}</span>,
                                      em: ({children}) => <em className="italic">{children}</em>,
                                    }}
                                  >
                                    {sacrifice}
                                  </ReactMarkdown>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {/* Weighted Scores */}
            {comparison.length > 0 && (
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Weighted Scores</h4>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                  {comparison
                    .sort((a, b) => b.totalScore - a.totalScore)
                    .map((score) => (
                      <SupplierScoreCard key={score.supplierId} score={score} />
                    ))}
                </div>
              </div>
            )}

            {/* Reasoning — rendered with custom components */}
            {reasoning && (
              <div>
                <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Full Reasoning</h4>
                <RichAnalysis text={reasoning} skuMap={skuMap} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
