"use client";

import { useState, useRef, useEffect } from "react";
import type { SupplierProfile, SupplierMatchResult } from "@/services/api-client";
import { createSupplierForQuotation, updateQuotationSupplier } from "@/services/api-client";

interface SupplierSectionProps {
  supplierMatch: SupplierMatchResult;
  allSuppliers: SupplierProfile[];
  quotationId: string;
  resolvedSupplier: SupplierProfile | null;
  onSupplierResolved: (supplier: SupplierProfile) => void;
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <span className="text-gray-400">{label}:</span>
      <span className="rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
        {value}
      </span>
    </div>
  );
}

function SupplierCard({ supplier }: { supplier: SupplierProfile }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      <MetricPill label="Quality" value={`${supplier.qualityRating} / 5`} />
      <MetricPill label="Price level" value={supplier.priceLevel} />
      <MetricPill label="Lead time" value={`${supplier.leadTimeDays}d`} />
      <MetricPill label="Terms" value={supplier.paymentTerms} />
    </div>
  );
}

function SupplierDropdown({
  allSuppliers,
  selectedId,
  onSelect,
  onCreateNew,
}: {
  allSuppliers: SupplierProfile[];
  selectedId: string | null;
  onSelect: (supplier: SupplierProfile) => void;
  onCreateNew: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
        Change
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="p-1.5">
            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Existing suppliers
            </div>
            {allSuppliers.filter(s => !s.isSimulated).map((supplier) => {
              const isSelected = supplier.id === selectedId;
              return (
                <button
                  key={supplier.id}
                  onClick={() => { onSelect(supplier); setIsOpen(false); }}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                    isSelected ? "bg-gray-100" : "hover:bg-gray-50"
                  }`}
                  title={supplier.name}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-gray-500">{supplier.code}</span>
                      <span className="truncate text-gray-900 max-w-[180px]">{supplier.name}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-gray-400">
                      {supplier.priceLevel} &middot; {supplier.leadTimeDays}d lead &middot; {supplier.qualityRating}/5
                    </div>
                  </div>
                  {isSelected && (
                    <svg className="h-3.5 w-3.5 shrink-0 text-gray-600" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              );
            })}

            <div className="my-1 border-t border-gray-100" />

            <button
              onClick={() => { onCreateNew(); setIsOpen(false); }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <svg className="h-3.5 w-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Create new supplier
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SupplierSection({
  supplierMatch,
  allSuppliers,
  quotationId,
  resolvedSupplier,
  onSupplierResolved,
}: SupplierSectionProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState(
    !supplierMatch.matched ? (supplierMatch.extractedName ?? "") : "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeSupplier = resolvedSupplier ?? (supplierMatch.matched ? supplierMatch.supplier : null);
  const isResolved = activeSupplier !== null;

  const handleSelectExisting = async (supplier: SupplierProfile) => {
    setIsSaving(true);
    setError(null);
    try {
      await updateQuotationSupplier(quotationId, supplier.id);
      onSupplierResolved(supplier);
      setIsCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update supplier");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCreateNew = async () => {
    if (!newName.trim()) return;
    setIsSaving(true);
    setError(null);
    try {
      const supplier = await createSupplierForQuotation(quotationId, newName.trim());
      onSupplierResolved(supplier);
      setIsCreating(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create supplier");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={`rounded-lg border bg-white p-4 ${
      !isResolved ? "border-amber-200 bg-amber-50/30" : "border-gray-200"
    }`}>
      {error && (
        <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Resolved state: show supplier card with edit option */}
      {isResolved && !isCreating && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Supplier
              </span>
              <span className="text-sm font-semibold text-gray-900">
                {activeSupplier.name}
              </span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-500">
                {activeSupplier.code}
              </span>
            </div>
            <SupplierDropdown
              allSuppliers={allSuppliers}
              selectedId={activeSupplier.id}
              onSelect={handleSelectExisting}
              onCreateNew={() => setIsCreating(true)}
            />
          </div>
          <SupplierCard supplier={activeSupplier} />
        </div>
      )}

      {/* Unresolved state: prompt user to select or create */}
      {!isResolved && !isCreating && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <span className="text-sm font-semibold text-gray-800">
              {supplierMatch.matched ? "Supplier" : "New supplier detected"}
            </span>
            {!supplierMatch.matched && supplierMatch.extractedName && (
              <span className="text-sm text-gray-500">
                &mdash; &ldquo;{supplierMatch.extractedName}&rdquo; found in spreadsheet
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Select an existing supplier or create a new one to continue.
          </p>
          <div className="flex items-center gap-2">
            <SupplierDropdown
              allSuppliers={allSuppliers}
              selectedId={null}
              onSelect={handleSelectExisting}
              onCreateNew={() => setIsCreating(true)}
            />
            <button
              onClick={() => setIsCreating(true)}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
            >
              <svg className="h-3.5 w-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              Create new
            </button>
          </div>
        </div>
      )}

      {/* Create new supplier inline form */}
      {isCreating && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Create new supplier</span>
            <button
              onClick={() => setIsCreating(false)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Supplier name"
              className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateNew(); }}
              autoFocus
            />
            <button
              onClick={handleCreateNew}
              disabled={!newName.trim() || isSaving}
              className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {isSaving && !isCreating && (
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-400">
          <div className="h-3 w-3 rounded-full border-2 border-gray-200 border-t-gray-500 animate-spin" />
          Updating...
        </div>
      )}
    </div>
  );
}
