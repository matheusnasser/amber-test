"use client";

import { useMemo } from "react";

// ─── Types ──────────────────────────────────────────────────────────────────

export type StepId = "upload" | "review" | "negotiate" | "requote" | "decision";

export interface SupplierProgress {
  name: string;
  currentRound: number;
  totalRounds: number;
  complete: boolean;
}

interface WorkflowStepperProps {
  currentPhase: StepId;
  supplierProgress?: Map<string, SupplierProgress>;
  onStepClick?: (stepId: StepId) => void;
  showReQuote?: boolean;
}

// ─── Step definitions ───────────────────────────────────────────────────────

interface StepDef {
  id: StepId;
  label: string;
}

const BASE_STEPS: StepDef[] = [
  { id: "upload", label: "Upload" },
  { id: "review", label: "Review" },
  { id: "negotiate", label: "Negotiate" },
  { id: "decision", label: "Decision" },
];

const REQUOTE_STEP: StepDef = { id: "requote", label: "Re-Quote" };

// ─── Horizontal Stepper ─────────────────────────────────────────────────────

export function WorkflowStepper({ currentPhase, supplierProgress, onStepClick, showReQuote }: WorkflowStepperProps) {
  const steps = useMemo(() => {
    if (!showReQuote) return BASE_STEPS;
    // Insert "Re-Quote" between "Negotiate" and "Decision"
    const copy = [...BASE_STEPS];
    const decisionIdx = copy.findIndex((s) => s.id === "decision");
    copy.splice(decisionIdx, 0, REQUOTE_STEP);
    return copy;
  }, [showReQuote]);

  const currentIdx = steps.findIndex((s) => s.id === currentPhase);

  // Build negotiation progress text
  let negotiateSubtext = "";
  const isNegotiating = currentPhase === "negotiate" || currentPhase === "requote";
  if (isNegotiating && supplierProgress && supplierProgress.size > 0) {
    const total = supplierProgress.size;
    const done = Array.from(supplierProgress.values()).filter((s) => s.complete).length;
    if (done === total) {
      negotiateSubtext = "Finalizing...";
    } else {
      const active = Array.from(supplierProgress.values()).find((s) => !s.complete && s.currentRound > 0);
      negotiateSubtext = active ? `${active.name} R${active.currentRound}` : `${done}/${total} done`;
    }
  }

  return (
    <div className="flex items-center justify-center gap-0">
      {steps.map((step, idx) => {
        const isComplete = idx < currentIdx;
        const isActive = idx === currentIdx;
        const isPending = idx > currentIdx;

        return (
          <div key={step.id} className="flex items-center">
            {/* Step */}
            <button
              type="button"
              disabled={isPending || (isComplete && currentIdx >= 2)}
              onClick={() => !isPending && !(isComplete && currentIdx >= 2) && onStepClick?.(step.id)}
              className={`flex flex-col items-center ${(isComplete && currentIdx < 2) || isActive ? "cursor-pointer" : "cursor-default"}`}
            >
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all ${
                  isComplete
                    ? "bg-gray-800 text-white hover:bg-gray-700"
                    : isActive
                      ? step.id === "requote"
                        ? "bg-orange-500 text-white shadow-sm shadow-orange-200 ring-2 ring-orange-200"
                        : "bg-amber-400 text-white shadow-sm shadow-amber-200 ring-2 ring-amber-200"
                      : "border border-gray-300 bg-white text-gray-400"
                }`}
              >
                {isComplete ? (
                  <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : step.id === "requote" ? (
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                ) : (
                  idx + 1
                )}
              </div>
              <span
                className={`mt-1 text-[10px] leading-tight ${
                  isActive ? "font-semibold text-gray-900" : isComplete ? "font-medium text-gray-600" : "text-gray-400"
                }`}
              >
                {step.label}
              </span>
              {/* Sub-text for negotiate / requote */}
              {(step.id === "negotiate" || step.id === "requote") && isActive && negotiateSubtext && (
                <span className="text-[9px] text-amber-600 font-medium animate-pulse">{negotiateSubtext}</span>
              )}
            </button>

            {/* Connector */}
            {idx < steps.length - 1 && (
              <div
                className={`mx-2 h-0.5 w-8 sm:w-12 transition-colors ${
                  idx < currentIdx ? "bg-gray-800" : "bg-gray-200"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// Keep old exports as aliases for backward compatibility
export { WorkflowStepper as WorkflowSidebar, WorkflowStepper as MobileStepper };
