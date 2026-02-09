"use client";

import { calculateCashFlowCost, formatCurrency } from "@/lib/formatting";
import type { SupplierAllocation } from "@/services/api-client";

interface CashFlowInsightsProps {
  allocations: SupplierAllocation[];
  selectedSupplierId?: string;
}

export function CashFlowInsights({ allocations, selectedSupplierId }: CashFlowInsightsProps) {
  // If a selected supplier is specified, only show that one
  const visibleAllocations = selectedSupplierId
    ? allocations.filter((a) => a.supplierId === selectedSupplierId)
    : allocations;

  const rows = visibleAllocations.map((alloc) => {
    const cashFlowCost = calculateCashFlowCost(
      alloc.agreedCost,
      alloc.paymentTerms,
      alloc.leadTimeDays,
    );
    return {
      ...alloc,
      fobCost: alloc.agreedCost,
      cashFlowCost,
      effectiveLandedCost: alloc.agreedCost + cashFlowCost,
    };
  });

  const totalFob = rows.reduce((sum, r) => sum + r.fobCost, 0);
  const totalCashFlow = rows.reduce((sum, r) => sum + r.cashFlowCost, 0);
  const totalLanded = rows.reduce((sum, r) => sum + r.effectiveLandedCost, 0);
  const bestLanded = Math.min(...rows.map((r) => r.effectiveLandedCost));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">Cash Flow Impact</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">
            8% annual cost of capital · daily compounding · payment term structure
          </p>
        </div>
        {totalCashFlow < 0 && (
          <div className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
            {formatCurrency(Math.abs(totalCashFlow))} cash flow advantage
          </div>
        )}
        {totalCashFlow > 0 && (
          <div className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
            {formatCurrency(totalCashFlow)} capital locked
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-400">
              <th className="pb-2 pr-4 font-medium">Supplier</th>
              <th className="pb-2 pr-4 font-medium text-right">FOB Cost</th>
              <th className="pb-2 pr-4 font-medium text-right">PV Impact</th>
              <th className="pb-2 pr-4 font-medium text-right">Terms</th>
              <th className="pb-2 pr-4 font-medium text-right">Lead</th>
              <th className="pb-2 font-medium text-right">Effective Landed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isBest = rows.length > 1 && row.effectiveLandedCost === bestLanded;
              const isSaving = row.cashFlowCost < 0;
              return (
                <tr key={row.supplierId} className="border-b border-gray-50">
                  <td className="py-2.5 pr-4 text-gray-700 font-medium">
                    {row.supplierName}
                    {isBest && (
                      <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700">
                        Best landed
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-gray-600 tabular-nums">
                    {formatCurrency(row.fobCost)}
                  </td>
                  <td className={`py-2.5 pr-4 text-right tabular-nums font-medium ${
                    isSaving ? "text-emerald-600" : row.cashFlowCost > 0 ? "text-amber-600" : "text-gray-600"
                  }`}>
                    {isSaving
                      ? `+${formatCurrency(Math.abs(row.cashFlowCost))}`
                      : row.cashFlowCost > 0
                        ? `-${formatCurrency(row.cashFlowCost)}`
                        : formatCurrency(0)}
                    <span className={`ml-1 text-[9px] font-normal ${isSaving ? "text-emerald-500" : row.cashFlowCost > 0 ? "text-amber-500" : "text-gray-400"}`}>
                      {isSaving ? "advantage" : row.cashFlowCost > 0 ? "locked" : ""}
                    </span>
                  </td>
                  <td className="py-2.5 pr-4 text-right text-gray-500 text-xs">
                    {row.paymentTerms}
                  </td>
                  <td className="py-2.5 pr-4 text-right text-gray-500 text-xs tabular-nums">
                    {row.leadTimeDays}d
                  </td>
                  <td className="py-2.5 text-right font-semibold text-gray-800 tabular-nums">
                    {formatCurrency(row.effectiveLandedCost)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200">
              <td className="pt-3 pr-4 font-semibold text-gray-800">Total</td>
              <td className="pt-3 pr-4 text-right font-semibold text-gray-800 tabular-nums">
                {formatCurrency(totalFob)}
              </td>
              <td className={`pt-3 pr-4 text-right font-semibold tabular-nums ${
                totalCashFlow < 0 ? "text-emerald-600" : totalCashFlow > 0 ? "text-amber-600" : "text-gray-800"
              }`}>
                {totalCashFlow < 0 ? `+${formatCurrency(Math.abs(totalCashFlow))}` : totalCashFlow > 0 ? `-${formatCurrency(totalCashFlow)}` : formatCurrency(0)}
              </td>
              <td className="pt-3 pr-4" />
              <td className="pt-3 pr-4" />
              <td className="pt-3 text-right font-bold text-gray-900 tabular-nums">
                {formatCurrency(totalLanded)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
