"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileUpload } from "@/components/FileUpload";
import { ParsingLoader } from "@/components/ParsingLoader";
import { QuotationTable } from "@/components/QuotationTable";
import { SupplierSection } from "@/components/SupplierSection";
import { ParsedDataPreview } from "@/components/ParsedDataPreview";
import { NegotiationPanel } from "@/components/NegotiationPanel";
import type { PillarActivity } from "@/components/NegotiationPanel";
import { FinalDecision } from "@/components/FinalDecision";
import { OrchestrationFlow } from "@/components/OrchestrationFlow";
import { WorkflowStepper } from "@/components/WorkflowSidebar";
import type { SupplierProgress, StepId } from "@/components/WorkflowSidebar";
import { parseQuotation, confirmSelections, getQuotation, getNegotiationByQuotation, getDecision, startReQuote, logout } from "@/services/api-client";
import type { ParseResponse, FinalDecisionData, SupplierProfile } from "@/services/api-client";

type Step = StepId;

export default function Home() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen"><div className="h-8 w-8 rounded-full border-4 border-gray-200 border-t-gray-600 animate-spin" /></div>}>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialQuotationId = searchParams.get("quotationId");
  const initialStep = searchParams.get("step");

  const [step, setStep] = useState<Step>(() => {
    if (initialQuotationId) {
      if (initialStep === "decision") return "decision";
      if (initialStep === "negotiate") return "negotiate";
      return "review";
    }
    return "upload";
  });
  const [isLoading, setIsLoading] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completedNegotiationId, setCompletedNegotiationId] = useState<string | null>(null);
  const [finalDecision, setFinalDecision] = useState<FinalDecisionData | null>(null);
  const [supplierProgress, setSupplierProgress] = useState<Map<string, SupplierProgress>>(new Map());
  const [userPlan, setUserPlan] = useState<{ notes: string; maxRounds: number } | null>(null);
  const [resolvedSupplier, setResolvedSupplier] = useState<SupplierProfile | null>(null);
  const [pillarActivities, setPillarActivities] = useState<PillarActivity[]>([]);
  const [reQuoteParams, setReQuoteParams] = useState<{ supplierIds: string[]; qtyChanges: Record<string, { from: number; to: number }> } | null>(null);
  const [isReQuoting, setIsReQuoting] = useState(false);
  const [preReQuoteDecision, setPreReQuoteDecision] = useState<FinalDecisionData | null>(null);
  const [showFlow, setShowFlow] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<FinalDecisionData | null>(null);

  // Define updateUrl before using it in useEffects
  const updateUrl = useCallback((params: Record<string, string | null>) => {
    const url = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(params)) {
      if (value === null) {
        url.delete(key);
      } else {
        url.set(key, value);
      }
    }
    const query = url.toString();
    router.replace(query ? `?${query}` : "/", { scroll: false });
  }, [router, searchParams]);

  // Stable ref for updateUrl to avoid effect dependency churn
  const updateUrlRef = useRef(updateUrl);
  updateUrlRef.current = updateUrl;

  // Auto-advance to decision when pendingDecision is set
  useEffect(() => {
    if (pendingDecision) {
      setFinalDecision(pendingDecision);
      setPendingDecision(null);
      setReQuoteParams(null);
      // Use queueMicrotask to batch with the setState calls above
      queueMicrotask(() => {
        setStep("decision");
        updateUrlRef.current({ step: "decision" });
      });
    }
  }, [pendingDecision]);

  const quotationId = parseResult?.quotationId ?? initialQuotationId;

  // Load stored parse result when quotationId is in URL but no parseResult yet
  useEffect(() => {
    if (initialQuotationId && !parseResult && !isLoading) {
      setIsLoading(true);
      getQuotation(initialQuotationId)
        .then((data) => {
          setParseResult(data);
          // Restore user plan from stored notes
          if (data.notes) {
            setUserPlan((prev) => prev ?? { notes: data.notes ?? "", maxRounds: 5 });
          }
          // If step is still upload (shouldn't happen, but safety), move to review
          if (step === "upload") setStep("review");
        })
        .catch((err) => {
          console.error("Failed to load quotation:", err);
          setError("Failed to load quotation session. Please upload a new file.");
          setStep("upload");
        })
        .finally(() => setIsLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuotationId]);

  // Load stored decision when returning to decision step via URL
  useEffect(() => {
    if (initialStep === "decision" && initialQuotationId && !finalDecision) {
      getNegotiationByQuotation(initialQuotationId).then(async (neg) => {
        if (neg && neg.status === "completed") {
          const decision = await getDecision(neg.id);
          if (decision && decision.recommendation) {
            setFinalDecision(decision);
            setCompletedNegotiationId(neg.id);
          }
        }
      }).catch((err) => console.error("Failed to load decision:", err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStep, initialQuotationId]);

  // Sidebar phase matches the current step directly
  const sidebarPhase = step;

  const handleUpload = async (file: File, notes: string, maxRounds: number) => {
    setIsLoading(true);
    setError(null);

    try {
      const data = await parseQuotation(file, notes);
      setParseResult(data);
      setUserPlan({ notes, maxRounds });
      setStep("review");
      updateUrl({ quotationId: data.quotationId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleProceed = async (selections: Record<string, string | null>) => {
    if (!quotationId) return;

    setIsLoading(true);
    setError(null);

    try {
      // Save user's HIL selections to DB
      await confirmSelections(quotationId, selections);

      // Move to negotiate step
      setStep("negotiate");
      updateUrl({ step: "negotiate" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm selections");
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setStep("upload");
    setParseResult(null);
    setError(null);
    setCompletedNegotiationId(null);
    setFinalDecision(null);
    setSupplierProgress(new Map());
    setResolvedSupplier(null);
    setReQuoteParams(null);
    setIsReQuoting(false);
    setPreReQuoteDecision(null);
    updateUrl({ quotationId: null, step: null });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ─── Top bar with stepper ─── */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-3 lg:px-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <h1 className="text-sm font-bold text-gray-900">Valden Outdoor</h1>
              <div className="hidden sm:block h-4 w-px bg-gray-200" />
              <WorkflowStepper
                currentPhase={sidebarPhase}
                supplierProgress={supplierProgress}
                onStepClick={(s) => setStep(s)}
                showReQuote={isReQuoting}
              />
            </div>
            <div className="flex items-center gap-2">
              {step !== "upload" && (
                <button
                  onClick={handleReset}
                  className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
                >
                  New Upload
                </button>
              )}
              <button
                onClick={logout}
                className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* ─── Main content ─── */}
      <main>
        <div className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
          {/* Error banner */}
          {error && (
            <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
              <span className="font-medium text-gray-900">Error:</span> {error}
            </div>
          )}

          {/* Step: Upload */}
          {step === "upload" && (
            <section>
              <h2 className="mb-4 text-lg font-semibold text-gray-800">Upload Quotation</h2>
              <div className="mx-auto max-w-xl">
                <FileUpload onUpload={handleUpload} isLoading={isLoading} />
              </div>
            </section>
          )}

          {/* Step: Review — loading state */}
          {step === "review" && !parseResult && isLoading && (
            <section>
              <ParsingLoader />
            </section>
          )}

          {/* Step: Review */}
          {step === "review" && parseResult && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-gray-800">Review Parsed Quotation</h2>
                <span className="text-xs text-gray-400 font-mono">
                  {parseResult.quotationId}
                </span>
              </div>

              {/* Supplier identification */}
              <SupplierSection
                supplierMatch={parseResult.supplierMatch}
                allSuppliers={parseResult.allSuppliers}
                quotationId={parseResult.quotationId}
                resolvedSupplier={resolvedSupplier}
                onSupplierResolved={setResolvedSupplier}
              />

              {/* Parsed data overview: sheets, notes, pricing table */}
              <ParsedDataPreview
                products={parseResult.products}
                sheets={parseResult.sheets}
                notes={parseResult.notes}
                sheetMetadata={parseResult.sheetMetadata}
              />

              {/* Product matching HIL */}
              <QuotationTable
                products={parseResult.products}
                matchSummary={parseResult.matchSummary}
                onProceed={handleProceed}
                supplierResolved={parseResult.supplierMatch.matched || resolvedSupplier !== null}
              />
              {isLoading && (
                <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
                  <div className="h-4 w-4 rounded-full border-2 border-gray-200 border-t-gray-500 animate-spin" />
                  Saving selections...
                </div>
              )}
            </section>
          )}

          {/* Step: Negotiate / Re-Quote */}
          {(step === "negotiate" || step === "requote") && quotationId && (
            <section className="space-y-8">
              {/* Quoting Plan + Live Pillars */}
              {userPlan && (
                <div className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Quoting Plan</h3>
                    {pillarActivities.some((p) => p.status === "active") && (
                      <div className="flex items-center gap-1.5">
                        <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                        <span className="text-[10px] text-emerald-600 font-medium">Agents working</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3 text-sm text-gray-700 mb-3">
                    {userPlan.notes && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-400">Priority:</span>
                        <span className="rounded-full bg-gray-100 border border-gray-200 px-2.5 py-0.5 text-xs font-medium">{userPlan.notes}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-400">Max rounds:</span>
                      <span className="rounded-full bg-gray-100 border border-gray-200 px-2.5 py-0.5 text-xs font-medium">{userPlan.maxRounds} per supplier</span>
                    </div>
                  </div>
                  {/* Live Pillar Activity */}
                  {pillarActivities.length > 0 && (
                    <div className="border-t border-gray-100 pt-3 mt-1">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-2">Brand Agent Pillars</div>
                      <div className="flex flex-wrap gap-2">
                        {(() => {
                          // Group by pillar, show latest status
                          const pillarMap = new Map<string, PillarActivity>();
                          for (const p of pillarActivities) {
                            const key = p.pillar;
                            const existing = pillarMap.get(key);
                            if (!existing || p.roundNumber > existing.roundNumber || (p.roundNumber === existing.roundNumber && p.status === "active")) {
                              pillarMap.set(key, p);
                            }
                          }
                          const PILLAR_ICONS: Record<string, string> = { negotiator: "N", riskAnalyst: "R", productCost: "C" };
                          const PILLAR_LABELS: Record<string, string> = { negotiator: "Negotiator", riskAnalyst: "Risk Analyst", productCost: "Cost Specialist" };
                          return Array.from(pillarMap.values()).map((p) => (
                            <div
                              key={p.pillar}
                              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-all ${
                                p.status === "active"
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-gray-200 bg-gray-50 text-gray-500"
                              }`}
                            >
                              <span>{PILLAR_ICONS[p.pillar] ?? "-"}</span>
                              <span className="font-medium">{PILLAR_LABELS[p.pillar] ?? p.pillar}</span>
                              {p.status === "active" && (
                                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              )}
                              {p.status === "complete" && (
                                <span className="text-emerald-600">done</span>
                              )}
                              <span className="text-[9px] text-gray-400">R{p.roundNumber}</span>
                            </div>
                          ));
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <NegotiationPanel
                quotationId={quotationId}
                maxRounds={userPlan?.maxRounds}
                userNotes={userPlan?.notes}
                products={parseResult?.products}
                onComplete={(negId) => setCompletedNegotiationId(negId)}
                onDecision={(decision) => setPendingDecision(decision)}
                onProgressUpdate={(progress) => setSupplierProgress(progress)}
                onPillarUpdate={(pillars) => setPillarActivities(pillars)}
                reQuoteParams={reQuoteParams}
                showFlow={showFlow}
                onToggleFlow={() => setShowFlow(!showFlow)}
              />

            </section>
          )}

          {/* Step: Decision */}
          {step === "decision" && finalDecision && finalDecision.recommendation && (
            <section className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-800">Decision</h2>
                  <p className="text-xs text-gray-400 mt-0.5">Review the AI recommendation and finalize your order</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setStep("negotiate")}
                    className="rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
                  >
                    Back to Negotiation
                  </button>
                  {completedNegotiationId && (
                    <a
                      href={`/orchestration?id=${completedNegotiationId}`}
                      target="_blank"
                      className="rounded border border-gray-200 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 transition-colors flex items-center gap-1.5"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                      </svg>
                      Orchestration
                    </a>
                  )}
                </div>
              </div>

              <FinalDecision
                decision={finalDecision}
                preReQuoteDecision={preReQuoteDecision}
                onRequestReQuote={(supplierIds, qtyChanges) => {
                  // Store pre-requote decision for later comparison
                  setPreReQuoteDecision(finalDecision);
                  // Reset decision state and go to requote step
                  setFinalDecision(null);
                  setCompletedNegotiationId(null);
                  setSupplierProgress(new Map());
                  setPillarActivities([]);
                  setIsReQuoting(true);
                  setStep("requote");
                  updateUrl({ step: "negotiate" });

                  // Store re-quote params so NegotiationPanel can pick them up
                  setReQuoteParams({ supplierIds, qtyChanges });
                }}
              />
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
