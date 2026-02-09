"use client";

import { useState } from "react";
import type { GroupedProduct, SheetInfo, SheetMetadata } from "@/services/api-client";

interface ParsedDataPreviewProps {
  products: GroupedProduct[];
  sheets: SheetInfo[];
  notes: string | null;
  sheetMetadata?: Record<string, SheetMetadata>;
}

function formatPrice(value: number | null): string {
  if (value === null) return "-";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQty(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString("en-US");
}

export function ParsedDataPreview({ products, sheets, notes, sheetMetadata }: ParsedDataPreviewProps) {
  const [isOpen, setIsOpen] = useState(false);

  const totalItems = products.reduce((sum, p) => sum + p.tiers.length, 0);
  
  // Determine tier grouping strategy:
  // - Multiple sheets → group by sheet (each sheet = a pricing tier)
  // - Single sheet with qty tiers in headers → group by quantity
  const uniqueSheets = new Set(products.flatMap((p) => p.tiers.map((t) => t.sheetName)));
  const hasMultipleSheets = uniqueSheets.size > 1;
  const hasQtyTiers = products.some((p) => p.tiers.length > 1);

  let tierEstimates: { label: string; total: number; productCount: number }[] = [];

  if (hasMultipleSheets) {
    // Group by sheet
    const sheetTotals = new Map<string, { label: string; total: number; productCount: number }>();
    for (const product of products) {
      for (const tier of product.tiers) {
        const key = tier.sheetName;
        const total = tier.rawTotalPrice ?? ((tier.rawUnitPrice ?? 0) * (tier.rawQuantity ?? 0));
        const existing = sheetTotals.get(key);
        if (existing) {
          existing.total += total;
          existing.productCount++;
        } else {
          sheetTotals.set(key, { label: key, total, productCount: 1 });
        }
      }
    }
    tierEstimates = Array.from(sheetTotals.values())
      .filter((s) => s.productCount >= 2)
      .sort((a, b) => a.total - b.total);
  } else if (hasQtyTiers) {
    // Single sheet — group by quantity (header-based tiers)
    const qtyTotals = new Map<number, { label: string; total: number; productCount: number }>();
    for (const product of products) {
      for (const tier of product.tiers) {
        const qty = tier.rawQuantity ?? 0;
        if (qty <= 0) continue;
        const total = tier.rawTotalPrice ?? ((tier.rawUnitPrice ?? 0) * qty);
        const existing = qtyTotals.get(qty);
        if (existing) {
          existing.total += total;
          existing.productCount++;
        } else {
          qtyTotals.set(qty, { label: `Qty ${formatQty(qty)}`, total, productCount: 1 });
        }
      }
    }
    // Only show qty tiers used by majority of products (≥50%)
    const threshold = Math.max(Math.floor(products.length * 0.5), 2);
    tierEstimates = Array.from(qtyTotals.values())
      .filter((t) => t.productCount >= threshold)
      .sort((a, b) => a.total - b.total);
  }

  const uniqueTierCount = tierEstimates.length;

  return (
    <div className="space-y-3">
      {/* Notes */}
      {notes && (
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <div className="flex items-center gap-2 mb-1">
            <svg className="h-3.5 w-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Negotiation notes
            </span>
          </div>
          <p className="text-sm text-gray-700">{notes}</p>
        </div>
      )}

      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
        <span>
          {sheets.length} sheet{sheets.length !== 1 ? "s" : ""}:
          {" "}{sheets.map((s) => `${s.sheetName} (${s.rows}r)`).join(", ")}
        </span>
        <span className="h-3 w-px bg-gray-200" />
        <span>{products.length} unique products</span>
        <span className="h-3 w-px bg-gray-200" />
        <span>{totalItems} line items</span>
        {uniqueTierCount > 1 && (
          <>
            <span className="h-3 w-px bg-gray-200" />
            <span>{uniqueTierCount} pricing tiers</span>
          </>
        )}
      </div>
      
      {/* Stats + Pricing tier estimates in one row */}
      <div className="flex flex-wrap items-stretch gap-3">
        {/* Products stat */}
        <div className="rounded-md border border-gray-200 bg-white px-4 py-2 text-center min-w-[100px]">
          <div className="text-xl font-semibold text-gray-900">{products.length}</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Products</div>
        </div>
        
        {/* Matched stat */}
        <div className="rounded-md border border-gray-200 bg-white px-4 py-2 text-center min-w-[100px]">
          <div className="text-xl font-semibold text-gray-900">
            {products.filter(p => p.productId).length}
          </div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400">Matched</div>
        </div>

        {/* Pricing tier estimates */}
        {tierEstimates.map((tier, idx) => (
          <div key={idx} className="rounded-md border border-gray-200 bg-white px-4 py-2 text-center min-w-[140px]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400 mb-1">
              {tier.label}
            </div>
            <div className="text-xl font-semibold text-gray-900">{formatPrice(tier.total)}</div>
            <div className="text-[9px] font-medium uppercase tracking-wider text-gray-400 mt-0.5">
              Est. order total
            </div>
          </div>
        ))}
      </div>

      {/* Sheet metadata — payment terms, lead time, incoterm, etc. */}
      {sheetMetadata && Object.keys(sheetMetadata).length > 0 && (() => {
        // Merge all sheet metadata into a single display (deduplicated)
        const merged: { label: string; value: string }[] = [];
        const seen = new Set<string>();
        for (const meta of Object.values(sheetMetadata)) {
          if (meta.paymentTerms && !seen.has(`terms:${meta.paymentTerms}`)) {
            seen.add(`terms:${meta.paymentTerms}`);
            merged.push({ label: "Payment", value: meta.paymentTerms });
          }
          if (meta.leadTimeDays && !seen.has(`lead:${meta.leadTimeDays}`)) {
            seen.add(`lead:${meta.leadTimeDays}`);
            merged.push({ label: "Lead Time", value: `${meta.leadTimeDays} days` });
          }
          if (meta.incoterm && !seen.has(`inco:${meta.incoterm}`)) {
            seen.add(`inco:${meta.incoterm}`);
            merged.push({ label: "Incoterm", value: meta.incoterm });
          }
          if (meta.currency && !seen.has(`cur:${meta.currency}`)) {
            seen.add(`cur:${meta.currency}`);
            merged.push({ label: "Currency", value: meta.currency });
          }
          if (meta.moq && !seen.has(`moq:${meta.moq}`)) {
            seen.add(`moq:${meta.moq}`);
            merged.push({ label: "MOQ", value: meta.moq });
          }
          if (meta.validUntil && !seen.has(`valid:${meta.validUntil}`)) {
            seen.add(`valid:${meta.validUntil}`);
            merged.push({ label: "Valid Until", value: meta.validUntil });
          }
          if (meta.notes && !seen.has(`notes:${meta.notes}`)) {
            seen.add(`notes:${meta.notes}`);
            merged.push({ label: "Notes", value: meta.notes });
          }
        }
        if (merged.length === 0) return null;
        return (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Quotation info</span>
            {merged.map((item, idx) => (
              <span key={idx} className="text-gray-600">
                <span className="font-medium text-gray-500">{item.label}:</span> {item.value}
              </span>
            ))}
          </div>
        );
      })()}

      {/* Collapsible parsed table */}
      <div className="rounded-lg border border-gray-200 bg-white">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            <span className="text-sm font-semibold text-gray-700">
              Parsed data ({products.length} products)
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
          <div className="border-t border-gray-100 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 border-b border-gray-100">
                  <th className="px-4 py-2 text-left">SKU</th>
                  <th className="px-4 py-2 text-left">Description</th>
                  <th className="px-4 py-2 text-left">Sheet</th>
                  <th className="px-4 py-2 text-right">Qty</th>
                  <th className="px-4 py-2 text-right">Unit Price</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody className="text-sm">
                {products.map((product) =>
                  product.tiers.map((tier, tierIdx) => (
                    <tr
                      key={`${product.rawSku}-${tierIdx}`}
                      className="border-t border-gray-50 hover:bg-gray-50/50"
                    >
                      {tierIdx === 0 ? (
                        <>
                          <td className="px-4 py-1.5 font-mono text-xs text-gray-600" rowSpan={product.tiers.length}>
                            {product.rawSku || "-"}
                          </td>
                          <td className="px-4 py-1.5 text-gray-500 max-w-[250px] truncate" rowSpan={product.tiers.length}>
                            {product.rawDescription || "-"}
                          </td>
                        </>
                      ) : null}
                      <td className="px-4 py-1.5 text-xs text-gray-400">
                        {tier.sheetName}
                      </td>
                      <td className="px-4 py-1.5 text-right text-gray-600 tabular-nums">
                        {formatQty(tier.rawQuantity)}
                      </td>
                      <td className="px-4 py-1.5 text-right text-gray-600 tabular-nums">
                        {formatPrice(tier.rawUnitPrice)}
                      </td>
                      <td className="px-4 py-1.5 text-right text-gray-600 tabular-nums">
                        {tier.rawTotalPrice != null
                          ? formatPrice(tier.rawTotalPrice)
                          : tier.rawQuantity != null && tier.rawUnitPrice != null
                            ? formatPrice(tier.rawQuantity * tier.rawUnitPrice)
                            : "-"}
                      </td>
                      <td className="px-4 py-1.5 text-xs text-gray-400 max-w-[150px] truncate">
                        {tier.rawNotes || ""}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
