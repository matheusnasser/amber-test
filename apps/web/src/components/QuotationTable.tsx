"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import type { GroupedProduct, MatchSummary, CandidateProduct, PricingTier } from "@/services/api-client";

interface QuotationTableProps {
  products: GroupedProduct[];
  matchSummary: MatchSummary;
  onProceed: (selections: Record<string, string | null>) => void;
  supplierResolved?: boolean;
}

function formatPrice(value: number | null): string {
  if (value === null) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQty(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("en-US");
}

// ─── Custom popover for candidate selection ─────────────────────────────────

function CandidatePopover({
  candidates,
  selectedProductId,
  onSelect,
}: {
  candidates: CandidateProduct[];
  selectedProductId: string | null;
  onSelect: (productId: string | null) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  const selected = candidates.find((c) => c.productId === selectedProductId);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  if (candidates.length === 0) {
    return <div className="text-sm text-gray-400 italic">No candidates found</div>;
  }

  return (
    <div className="relative" ref={popoverRef}>
      {/* Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ${
          selected
            ? "border-gray-300 bg-white text-gray-900"
            : "border-dashed border-gray-300 bg-gray-50/50 text-gray-500"
        } hover:border-gray-400`}
      >
        {selected ? (
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <span className="font-mono text-xs text-gray-500">{selected.sku}</span>
              <span className="mx-1.5 text-gray-300">|</span>
              <span>{selected.name}</span>
              {selected.color && <span className="ml-1.5 text-xs text-gray-500">&quot;{selected.color}&quot;</span>}
            </div>
            <svg className="ml-2 h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
            </svg>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span>Select a product match...</span>
            <svg className="ml-2 h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
            </svg>
          </div>
        )}
      </button>

      {/* Popover */}
      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="p-1.5">
            {/* Skip option */}
            <button
              onClick={() => { onSelect(null); setIsOpen(false); }}
              className={`flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors ${
                !selectedProductId ? "bg-gray-100 text-gray-700" : "text-gray-500 hover:bg-gray-50"
              }`}
            >
              <span className="text-gray-400 mr-2">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </span>
              Skip (no match)
            </button>

            <div className="my-1 border-t border-gray-100" />

            {/* Candidates */}
            {candidates.map((candidate) => {
              const isSelected = candidate.productId === selectedProductId;
              return (
                <button
                  key={candidate.productId}
                  onClick={() => { onSelect(candidate.productId); setIsOpen(false); }}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    isSelected ? "bg-gray-100" : "hover:bg-gray-50"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-500">{candidate.sku}</span>
                      <span className="truncate text-gray-900">{candidate.name}</span>
                      {candidate.color && <span className="text-xs text-gray-500">&quot;{candidate.color}&quot;</span>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <span className="text-xs tabular-nums text-gray-400">{Math.round(candidate.confidence * 100)}%</span>
                    {isSelected && (
                      <svg className="ml-1.5 inline h-3.5 w-3.5 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Compact pricing tiers table ─────────────────────────────────────────────

function TiersTable({ tiers }: { tiers: PricingTier[] }) {
  if (tiers.length === 0) return null;

  return (
    <table className="mt-2 w-full text-xs">
      <thead>
        <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          {tiers.length > 1 && <td className="pb-1 pr-2">Sheet</td>}
          <td className="pb-1 pr-2 text-right">Qty</td>
          <td className="pb-1 pr-2 text-right">Unit</td>
          <td className="pb-1 text-right">Total</td>
        </tr>
      </thead>
      <tbody>
        {tiers.map((tier, i) => (
          <tr key={i} className={i > 0 ? "border-t border-gray-100" : ""}>
            {tiers.length > 1 && (
              <td className="py-1 pr-2 text-gray-400 truncate max-w-[100px]">{tier.sheetName}</td>
            )}
            <td className="py-1 pr-2 text-right font-medium tabular-nums text-gray-600">
              {formatQty(tier.rawQuantity)}
            </td>
            <td className="py-1 pr-2 text-right font-medium tabular-nums text-gray-600">
              {formatPrice(tier.rawUnitPrice)}
            </td>
            <td className="py-1 text-right font-medium tabular-nums text-gray-600">
              {formatPrice(tier.rawTotalPrice)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Card for items needing attention ────────────────────────────────────────

function FlaggedItemCard({
  product,
  selectedProductId,
  onSelect,
}: {
  product: GroupedProduct;
  selectedProductId: string | null;
  onSelect: (productId: string | null) => void;
}) {
  const [showPopover, setShowPopover] = useState(false);
  const isUnmatched = product.matchConfidence === 0;
  const isLowConfidence = product.matchConfidence > 0 && product.matchConfidence < 0.5;
  const isResolved = selectedProductId !== null;
  const selected = product.candidates.find((c) => c.productId === selectedProductId);

  return (
    <div className={`rounded-lg border bg-white p-4 transition-all ${
      isResolved ? "border-gray-200" : "border-gray-300"
    }`}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {/* Status indicator */}
          <div className="flex items-center gap-2 mb-3">
            {isUnmatched ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Not found in catalog
              </span>
            ) : isLowConfidence ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Low confidence &middot; {Math.round(product.matchConfidence * 100)}%
              </span>
            ) : isResolved ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                Suggested match &middot; {Math.round(product.matchConfidence * 100)}%
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Needs review &middot; {Math.round(product.matchConfidence * 100)}%
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* From the spreadsheet */}
            <div className="rounded-md border border-gray-100 bg-gray-50/50 p-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                From spreadsheet
              </div>
              <div className="font-mono text-sm font-medium text-gray-900">
                {product.rawSku || "(no SKU)"}
              </div>
              <div className="mt-0.5 text-sm text-gray-500 line-clamp-2">
                {product.rawDescription || "(no description)"}
              </div>
              <TiersTable tiers={product.tiers} />
            </div>

            {/* Catalog match */}
            <div className="rounded-md border border-gray-100 bg-gray-50/50 p-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Catalog match
              </div>

              {/* Show confirmed card when a candidate is selected, popover when not */}
              {isResolved && selected && !showPopover ? (
                <div className="rounded-md border border-green-200 bg-green-50/60 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <svg className="h-3.5 w-3.5 shrink-0 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        <span className="font-mono text-xs font-medium text-gray-700">{selected.sku}</span>
                      </div>
                      <div className="mt-1 text-sm text-gray-900">{selected.name}</div>
                      {selected.color && (
                        <div className="mt-0.5 text-xs text-gray-500">{selected.color}</div>
                      )}
                    </div>
                    <button
                      onClick={() => setShowPopover(true)}
                      className="shrink-0 text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2 transition-colors"
                    >
                      Change
                    </button>
                  </div>
                </div>
              ) : (
                <CandidatePopover
                  candidates={product.candidates}
                  selectedProductId={selectedProductId}
                  onSelect={(id) => { onSelect(id); setShowPopover(false); }}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Collapsible section for auto-accepted items ─────────────────────────────

function AcceptedItemsSection({ products }: { products: GroupedProduct[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (products.length === 0) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-800 text-white">
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </span>
          <span className="text-sm font-semibold text-gray-800">
            {products.length} product{products.length !== 1 ? "s" : ""} confirmed
          </span>
          <span className="text-xs text-gray-400">
            — matched automatically
          </span>
        </div>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="border-t border-gray-100 px-4 pb-3 pt-2">
          <table className="w-full">
            <thead>
              <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                <td className="pb-2 pr-3">SKU</td>
                <td className="pb-2 pr-3">Product</td>
                <td className="pb-2 pr-3">Sheet</td>
                <td className="pb-2 pr-3 text-right">Qty</td>
                <td className="pb-2 pr-3 text-right">Unit Price</td>
                <td className="pb-2 pr-3 text-right">Total</td>
                <td className="pb-2 text-right">Confidence</td>
              </tr>
            </thead>
            <tbody className="text-sm">
              {products.map((product) => {
                const tiers = product.tiers;
                return tiers.map((tier, tierIdx) => (
                  <tr key={`${product.rawSku}-${tierIdx}`} className="border-t border-gray-100">
                    {tierIdx === 0 ? (
                      <>
                        <td className="py-1.5 pr-3 font-mono text-xs text-gray-600" rowSpan={tiers.length}>
                          {product.matchedSku ?? product.rawSku}
                        </td>
                        <td className="py-1.5 pr-3 text-gray-500 truncate max-w-[200px]" rowSpan={tiers.length}>
                          {product.productName ?? product.rawDescription}
                        </td>
                      </>
                    ) : null}
                    <td className="py-1.5 pr-3 text-xs text-gray-400 truncate max-w-[100px]">
                      {tier.sheetName}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">
                      {formatQty(tier.rawQuantity)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">
                      {formatPrice(tier.rawUnitPrice)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-gray-400 tabular-nums">
                      {formatPrice(tier.rawTotalPrice)}
                    </td>
                    {tierIdx === 0 ? (
                      <td className="py-1.5 text-right text-xs text-gray-400" rowSpan={tiers.length}>
                        {Math.round(product.matchConfidence * 100)}%
                      </td>
                    ) : null}
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function QuotationTable({ products, matchSummary, onProceed, supplierResolved = true }: QuotationTableProps) {
  const autoAccepted = useMemo(
    () => products.filter((p) => p.matchConfidence >= 0.85),
    [products],
  );

  const flagged = useMemo(
    () => products
      .filter((p) => p.matchConfidence < 0.85)
      .sort((a, b) => a.matchConfidence - b.matchConfidence),
    [products],
  );

  // Track user selections: rawSku → selected productId (null = skip/no match)
  const [selections, setSelections] = useState<Map<string, string | null>>(() => {
    const initial = new Map<string, string | null>();
    for (const p of products) {
      if (p.matchConfidence < 0.85 && p.productId) {
        initial.set(p.rawSku, p.productId);
      }
    }
    return initial;
  });

  const allResolved = flagged.length === 0 || flagged.every((p) => selections.has(p.rawSku));

  const handleSelect = (rawSku: string, productId: string | null) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.set(rawSku, productId);
      return next;
    });
  };

  const confirmAll = () => {
    const next = new Map(selections);
    for (const p of flagged) {
      if (!next.has(p.rawSku)) {
        next.set(p.rawSku, p.candidates[0]?.productId ?? null);
      }
    }
    setSelections(next);
  };

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="rounded-md border border-gray-200 bg-white px-4 py-2 text-center">
          <div className="text-xl font-semibold text-gray-900">{matchSummary.totalProducts}</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Products</div>
        </div>
        <div className="rounded-md border border-gray-200 bg-white px-4 py-2 text-center">
          <div className="text-xl font-semibold text-gray-900">{matchSummary.autoAccepted}</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Matched</div>
        </div>
        {(matchSummary.needsReview + matchSummary.needsAction + matchSummary.unmatched) > 0 && (
          <div className="rounded-md border border-gray-200 bg-white px-4 py-2 text-center">
            <div className="text-xl font-semibold text-amber-600">
              {matchSummary.needsReview + matchSummary.needsAction + matchSummary.unmatched}
            </div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Needs review</div>
          </div>
        )}
        
        {/* Pricing tiers summary */}
        {(() => {
          const totalTiers = products.reduce((sum, p) => sum + p.tiers.length, 0);
          const productsWithTiers = products.filter((p) => p.tiers.length > 1).length;
          const avgTiersPerProduct = totalTiers / products.length;
          
          return (
            <div className="ml-auto flex items-center gap-4 text-xs text-gray-500">
              <div>
                <span className="font-medium text-gray-700">{matchSummary.totalRawRows}</span> line items
              </div>
              {productsWithTiers > 0 && (
                <div className="flex items-center gap-1.5">
                  <svg className="h-3.5 w-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>
                    <span className="font-medium text-gray-700">{productsWithTiers}</span> with volume tiers
                    {avgTiersPerProduct > 1.5 && (
                      <span className="ml-1 text-gray-400">
                        (avg {avgTiersPerProduct.toFixed(1)} per product)
                      </span>
                    )}
                  </span>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Flagged items */}
      {flagged.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">
              Needs your attention ({flagged.length})
            </h3>
            {flagged.length > 1 && (
              <button
                onClick={confirmAll}
                className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Accept all suggestions
              </button>
            )}
          </div>

          <div className="space-y-2">
            {flagged.map((product) => (
              <FlaggedItemCard
                key={product.rawSku}
                product={product}
                selectedProductId={selections.get(product.rawSku) ?? (product.productId || null)}
                onSelect={(productId) => handleSelect(product.rawSku, productId)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Auto-accepted items — collapsed, read-only */}
      <AcceptedItemsSection products={autoAccepted} />

      {/* Proceed */}
      <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-4">
        <div className="text-sm text-gray-500">
          {!supplierResolved ? (
            <span>Select a supplier above before proceeding.</span>
          ) : allResolved ? (
            <span className="font-medium text-gray-700">All items reviewed. Ready to proceed.</span>
          ) : (
            <span>
              Review {flagged.length - selections.size} remaining item{flagged.length - selections.size !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        <button
          onClick={() => {
            // Build full selections map: auto-accepted + user choices
            const allSelections: Record<string, string | null> = {};
            for (const p of autoAccepted) {
              allSelections[p.rawSku] = p.productId;
            }
            for (const [rawSku, productId] of selections) {
              allSelections[rawSku] = productId;
            }
            onProceed(allSelections);
          }}
          disabled={!allResolved || !supplierResolved}
          className="rounded-lg bg-gray-900 px-6 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-30 disabled:shadow-none transition-colors"
        >
          Proceed to Negotiation
        </button>
      </div>
    </div>
  );
}
