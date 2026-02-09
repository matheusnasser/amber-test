/**
 * NEGOTIATION GRAPH - Multi-Supplier Orchestration (LangGraph StateGraph)
 *
 * Purpose: Coordinates synchronized negotiation rounds across 3 suppliers in parallel
 *
 * Suppliers:
 *   - SUP-001: From uploaded XLSX (real baseline supplier)
 *   - SUP-002: Alpine Premium (simulated - expensive, high quality)
 *   - SUP-003: RapidGear Co (simulated - fast, mid-range)
 *
 * Per-Round Flow (for EACH supplier in parallel):
 *   1. Brand Agent → Generates message (via 3-pillar graph if not RFQ)
 *   2. Supplier Agent → Responds with counter-offer
 *   3. Offer Extractor → Parses response into structured data
 *   4. Persist → Save messages + offers to DB
 *   5. Emit SSE → Stream events to frontend in real-time
 *
 * Graph Flow:
 *   START → initSuppliers → negotiateRound → checkConvergence ─┐
 *                               ▲                               │
 *                               └───── (more rounds) ──────────┘
 *                                                               │
 *                                                          ── END
 *
 * Special Handling:
 *   - Round 1 with SUP-002/003: Simple RFQ (quote request)
 *   - Round 1 with SUP-001: Present baseline XLSX offer
 *   - Curveball: Injected at Round 2 for SUP-002 (60% capacity constraint)
 *   - Convergence: Auto-eliminates non-competitive suppliers mid-loop
 *
 * State Tracking: Offers Map, Conversation Histories, Round Numbers, Phase
 *
 * ── KEY POINTS ──────────────────────────────────────────────────
 *   • Outer orchestrator — 3 supplier negotiations running simultaneously
 *   • Round 1 staged: quote S2/S3 first, then leverage their offers against S1
 *   • Cross-pollination: each supplier sees competing offers as competitive pressure
 *   • Real-time SSE streaming — pillars, messages, offers appear live in the UI
 * ────────────────────────────────────────────────────────────────
 */

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { prisma } from "@supplier-negotiation/database";
import { scoreAllOffers } from "@supplier-negotiation/shared";
import { createBrandMessage } from "./brand-agent";
import type { PillarEvent } from "./brand-graph";
import type { ContextSections } from "./context-builder";
import { formatSkuRef } from "./format-helpers";
import type { SSEEvent } from "./negotiation-loop";
import { extractOffer } from "./offer-extractor";
import {
  buildSupplierSystemPrompt,
  createSupplierResponse,
} from "./supplier-agent";
import type {
  MessageData,
  OfferData,
  QuotationItemData,
  SupplierProfile,
} from "./types";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_ROUNDS = 4;

// ─── State Annotation ────────────────────────────────────────────────────────

const NegotiationGraphState = Annotation.Root({
  // --- Inputs (set once at invocation) ---
  negotiationId: Annotation<string>(),
  quotationItems: Annotation<QuotationItemData[]>(),
  supplierProfiles: Annotation<SupplierProfile[]>(),
  userNotes: Annotation<string>(),
  phase: Annotation<"initial" | "post_curveball">(),
  maxRounds: Annotation<number>(),
  mode: Annotation<string>({ reducer: (_, b) => b, default: () => "balanced" }),
  quotationSupplierCode: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "SUP-001",
  }),
  curveballSupplierCode: Annotation<string | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  isReQuote: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  qtyChanges: Annotation<Record<string, { from: number; to: number }>>({
    reducer: (_, b) => b,
    default: () => ({}),
  }),
  onEvent: Annotation<(event: SSEEvent) => void>(),

  // --- Mutable state across rounds ---
  allOffers: Annotation<Record<string, OfferData>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  conversationHistories: Annotation<Record<string, MessageData[]>>({
    reducer: (current, update) => {
      const merged = { ...current };
      for (const [key, value] of Object.entries(update)) {
        merged[key] = value;
      }
      return merged;
    },
    default: () => ({}),
  }),
  previousOffers: Annotation<Record<string, OfferData>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  currentRound: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  isComplete: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
});

export type NegotiationGraphInput = typeof NegotiationGraphState.State;

// ─── Node: Initialize Suppliers ─────────────────────────────────────────────

async function initSuppliersNode(
  state: typeof NegotiationGraphState.State,
): Promise<Partial<typeof NegotiationGraphState.State>> {
  console.log(
    `\n[negotiation-graph] Initializing ${state.supplierProfiles.length} suppliers`,
  );

  state.onEvent({
    type: "negotiation_started",
    negotiationId: state.negotiationId,
    timestamp: Date.now(),
  });

  // Emit supplier_started for all (with params)
  for (const profile of state.supplierProfiles) {
    state.onEvent({
      type: "supplier_started",
      supplierId: profile.id,
      supplierName: profile.name,
      supplierCode: profile.code,
      quality: profile.qualityRating,
      priceLevel: profile.priceLevel,
      leadTime: profile.leadTimeDays,
      terms: profile.paymentTerms,
      isSimulated: profile.isSimulated,
      timestamp: Date.now(),
    });
  }

  // For post_curveball, preserve histories loaded from DB.
  // For initial phase, start fresh.
  if (state.phase === "initial") {
    const histories: Record<string, MessageData[]> = {};
    for (const profile of state.supplierProfiles) {
      histories[profile.id] = [];
    }
    return { conversationHistories: histories, currentRound: 1 };
  }

  // post_curveball: keep existing conversation histories, just reset round counter
  return { currentRound: 1 };
}

// ─── Node: Negotiate One Round (all active suppliers in parallel) ───────────

async function negotiateRoundNode(
  state: typeof NegotiationGraphState.State,
): Promise<Partial<typeof NegotiationGraphState.State>> {
  const roundNumber = state.currentRound;
  const maxRounds = state.maxRounds || MAX_ROUNDS;

  const activeSuppliers = state.supplierProfiles;

  console.log(
    `\n--- [negotiation-graph] Round ${roundNumber}/${maxRounds} — ${activeSuppliers.length} supplier(s) ---`,
  );

  // ── Round 1 ordering: S2/S3 quote first, then S1 uses their offers as leverage ──
  // In Round 1 initial phase, process non-XLSX suppliers first to gather competitive
  // offers, then process S1 (XLSX source) with those offers available as leverage.
  let suppliersInOrder: typeof activeSuppliers;
  if (roundNumber === 1 && state.phase === "initial") {
    const nonXlsx = activeSuppliers.filter(
      (p) => p.code !== state.quotationSupplierCode,
    );
    const xlsx = activeSuppliers.filter(
      (p) => p.code === state.quotationSupplierCode,
    );
    // S2/S3 go first; S1 waits
    suppliersInOrder = [...nonXlsx, ...xlsx];
    console.log(
      `  [negotiation-graph] R1 strategy: quoting ${nonXlsx.map((p) => p.code).join(", ")} first, then ${xlsx.map((p) => p.code).join(", ")} (leverage)`,
    );
  } else {
    suppliersInOrder = activeSuppliers;
  }

  // Snapshot offers for consistent competitive data
  let offersMap = new Map(Object.entries(state.allOffers));

  // For R1, we process in two waves: first non-XLSX, then XLSX with updated offers
  const isR1Staged = roundNumber === 1 && state.phase === "initial";
  const wave1Suppliers = isR1Staged
    ? suppliersInOrder.filter((p) => p.code !== state.quotationSupplierCode)
    : suppliersInOrder;
  const wave2Suppliers = isR1Staged
    ? suppliersInOrder.filter((p) => p.code === state.quotationSupplierCode)
    : [];

  // Emit "waiting" status for S1 during wave 1 — S1 will be negotiated after S2/S3 offers arrive
  if (isR1Staged && wave2Suppliers.length > 0) {
    for (const xlsxProfile of wave2Suppliers) {
      state.onEvent({
        type: "supplier_waiting",
        supplierId: xlsxProfile.id,
        supplierName: xlsxProfile.name,
        supplierCode: xlsxProfile.code,
        reason:
          "Gathering competitive quotes from other suppliers first to use as leverage",
        roundNumber,
        timestamp: Date.now(),
      } as SSEEvent);
    }
  }

  // Helper: process one supplier for this round
  const processSupplier = async (
    profile: (typeof activeSuppliers)[0],
    currentOffersMap: Map<string, OfferData>,
  ) => {
    const roundStartTime = Date.now();
    const isXlsxSource = profile.code === state.quotationSupplierCode;

    // Capture context/pillar data for persistence alongside offerData
    let capturedContextSections: ContextSections | undefined;
    let capturedContextSummary: string | undefined;
    const capturedPillarOutputs: Record<string, string> = {};

    state.onEvent({
      type: "round_start",
      supplierId: profile.id,
      roundNumber,
      timestamp: Date.now(),
    });

    // Create NegotiationRound in DB
    const round = await prisma.negotiationRound.create({
      data: {
        negotiationId: state.negotiationId,
        supplierId: profile.id,
        roundNumber,
        phase: state.phase,
        status: "in_progress",
      },
    });

    const history = state.conversationHistories[profile.id] ?? [];

    // ── S1 XLSX Opening Offer (Round 1 only) ──
    if (isXlsxSource && roundNumber === 1 && state.phase === "initial") {
      // XLSX IS S1's opening offer. Brand Agent evaluates, no supplier agent.
      // Use primary tier (smallest qty) for the baseline, but include volume tiers
      const baselineOffer: OfferData = {
        totalCost: state.quotationItems.reduce((s, i) => s + i.totalPrice, 0),
        items: state.quotationItems.map((i) => ({
          sku: i.rawSku,
          unitPrice: i.unitPrice,
          quantity: i.quantity,
          volumeTiers:
            i.tiers && i.tiers.length > 1
              ? i.tiers.map((t) => ({
                  minQty: t.quantity,
                  maxQty: null,
                  unitPrice: t.unitPrice,
                }))
              : undefined,
        })),
        leadTimeDays: profile.leadTimeDays,
        paymentTerms: profile.paymentTerms,
        concessions: [],
        conditions: [],
      };

      // Override lead time and payment terms from XLSX metadata if available
      const metadataNotes = state.userNotes;
      const leadMatch = metadataNotes.match(/Lead time:\s*(\d+)\s*days/i);
      if (leadMatch) baselineOffer.leadTimeDays = parseInt(leadMatch[1], 10);
      const termsMatch = metadataNotes.match(/Payment terms?:\s*([^\n|]+)/i);
      if (termsMatch) baselineOffer.paymentTerms = termsMatch[1].trim();

      // Brand Agent still evaluates (generates assessment)
      const brandMessageContent = await createBrandMessage({
        currentSupplierId: profile.id,
        negotiationId: state.negotiationId,
        quotationItems: state.quotationItems,
        userNotes: state.userNotes,
        supplierProfiles: state.supplierProfiles,
        allOffers: currentOffersMap,
        conversationHistory: history,
        roundNumber,
        totalRounds: maxRounds,
        isXlsxSource: true,
        onContextBuilt: (summary: string, sections: ContextSections) => {
          capturedContextSummary = summary;
          capturedContextSections = sections;
          state.onEvent({
            type: "context_built",
            supplierId: profile.id,
            roundNumber,
            summary,
            sections,
            timestamp: Date.now(),
          });
        },
        onPillarEvent: (pillarEvent: PillarEvent) => {
          if (pillarEvent.type === "pillar_complete" && pillarEvent.output) {
            capturedPillarOutputs[pillarEvent.pillar] = pillarEvent.output;
          }
          state.onEvent({
            type: pillarEvent.type,
            pillar: pillarEvent.pillar,
            supplierId: pillarEvent.supplierId,
            roundNumber: pillarEvent.roundNumber,
            ...(pillarEvent.output ? { output: pillarEvent.output } : {}),
            timestamp: Date.now(),
          });
        },
      });

      const brandMessage = await prisma.message.create({
        data: {
          roundId: round.id,
          role: "brand_agent",
          content: brandMessageContent,
        },
      });

      state.onEvent({
        type: "message",
        role: "brand_agent",
        supplierId: profile.id,
        supplierName: profile.name,
        content: brandMessageContent,
        roundNumber,
        phase: state.phase,
        messageId: brandMessage.id,
        timestamp: Date.now(),
      });

      // Synthetic supplier message: the XLSX quotation summary (with tiers)
      const hasTiers = state.quotationItems.some(
        (i) => i.tiers && i.tiers.length > 1,
      );

      // Build tier-level totals
      const tierTotals = new Map<number, number>();
      for (const item of state.quotationItems) {
        if (item.tiers && item.tiers.length > 1) {
          for (const tier of item.tiers) {
            tierTotals.set(
              tier.quantity,
              (tierTotals.get(tier.quantity) || 0) + tier.totalPrice,
            );
          }
        } else {
          tierTotals.set(
            item.quantity,
            (tierTotals.get(item.quantity) || 0) + item.totalPrice,
          );
        }
      }
      const sortedTierTotals = Array.from(tierTotals.entries()).sort(
        ([a], [b]) => a - b,
      );

      const itemLines = state.quotationItems
        .map((item) => {
          if (item.tiers && item.tiers.length > 1) {
            const tierLines = item.tiers
              .map(
                (t) =>
                  `  Qty ${t.quantity.toLocaleString()}: $${t.unitPrice.toFixed(2)}/unit ($${t.totalPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })} total)`,
              )
              .join("\n");
            return `- ${formatSkuRef(item.rawSku, item.rawDescription)}\n${tierLines}`;
          }
          return `- ${formatSkuRef(item.rawSku, item.rawDescription)}: $${item.unitPrice.toFixed(2)} x ${item.quantity.toLocaleString()} = $${item.totalPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
        })
        .join("\n");

      const tierSummaryLines = hasTiers
        ? `\nPricing Tiers:\n${sortedTierTotals.map(([qty, total]) => `  Qty ${qty.toLocaleString()}: $${total.toLocaleString("en-US", { minimumFractionDigits: 2 })} total`).join("\n")}`
        : `\nTotal: $${baselineOffer.totalCost.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

      const xlsxSummaryContent = `Thank you for considering us. Here is our quotation as submitted:${tierSummaryLines}\nLead Time: ${baselineOffer.leadTimeDays} days\nPayment Terms: ${baselineOffer.paymentTerms}\n\nPer-item breakdown:\n${itemLines}\n\nWe're open to discussing terms based on volume and commitment.`;

      const supplierMessage = await prisma.message.create({
        data: {
          roundId: round.id,
          role: "supplier_agent",
          content: xlsxSummaryContent,
        },
      });

      state.onEvent({
        type: "message",
        role: "supplier_agent",
        supplierId: profile.id,
        supplierName: profile.name,
        content: xlsxSummaryContent,
        roundNumber,
        phase: state.phase,
        messageId: supplierMessage.id,
        timestamp: Date.now(),
      });

      await prisma.negotiationRound.update({
        where: { id: round.id },
        data: {
          offerData: JSON.parse(JSON.stringify({
            ...baselineOffer,
            _contextSections: capturedContextSections ?? null,
            _contextSummary: capturedContextSummary ?? null,
            _pillarOutputs: Object.keys(capturedPillarOutputs).length > 0 ? capturedPillarOutputs : null,
          })),
          status: "completed",
        },
      });

      state.onEvent({
        type: "offer_extracted",
        supplierId: profile.id,
        roundNumber,
        offer: baselineOffer,
        timestamp: Date.now(),
      });

      const roundElapsed = Date.now() - roundStartTime;
      console.log(
        `  [${profile.code}] Round ${roundNumber} (XLSX opening offer) complete in ${roundElapsed}ms — offer: $${baselineOffer.totalCost.toLocaleString()}`,
      );

      state.onEvent({
        type: "round_end",
        supplierId: profile.id,
        roundNumber,
        timestamp: Date.now(),
      });

      return {
        supplierId: profile.id,
        offer: baselineOffer,
        history: [
          ...history,
          { role: "brand_agent" as const, content: brandMessageContent },
          { role: "supplier_agent" as const, content: xlsxSummaryContent },
        ],
      };
    }

    // ── Standard negotiation round (S2/S3 all rounds, S1 R2+) ──

    // For S2/S3 round 1: this is a quote request — just send SKUs + quantities
    // BUT skip RFQ if we already have seeded offers (re-quote) — go straight to negotiation
    const hasPriorOffer = !!state.allOffers[profile.id];
    const isQuoteRequest =
      !isXlsxSource &&
      roundNumber === 1 &&
      state.phase === "initial" &&
      !hasPriorOffer;

    const skipPillars = false;

    // Generate brand agent message via BrandGraph (3-pillar) or fast-path RFQ/re-quote
    const brandMessageContent = await createBrandMessage({
      currentSupplierId: profile.id,
      negotiationId: state.negotiationId,
      quotationItems: state.quotationItems,
      userNotes: state.userNotes,
      supplierProfiles: state.supplierProfiles,
      allOffers: currentOffersMap,
      conversationHistory: history,
      roundNumber,
      totalRounds: maxRounds,
      isXlsxSource,
      isQuoteRequest,
      isReQuote: state.isReQuote,
      qtyChanges:
        Object.keys(state.qtyChanges).length > 0 ? state.qtyChanges : undefined,
      priorOffer: state.allOffers[profile.id] ?? undefined,
      onContextBuilt: skipPillars
        ? undefined
        : (summary: string, sections: ContextSections) => {
            capturedContextSummary = summary;
            capturedContextSections = sections;
            state.onEvent({
              type: "context_built",
              supplierId: profile.id,
              roundNumber,
              summary,
              sections,
              timestamp: Date.now(),
            });
          },
      onPillarEvent: skipPillars
        ? undefined
        : (pillarEvent: PillarEvent) => {
            if (pillarEvent.type === "pillar_complete" && pillarEvent.output) {
              capturedPillarOutputs[pillarEvent.pillar] = pillarEvent.output;
            }
            state.onEvent({
              type: pillarEvent.type,
              pillar: pillarEvent.pillar,
              supplierId: pillarEvent.supplierId,
              roundNumber: pillarEvent.roundNumber,
              ...(pillarEvent.output ? { output: pillarEvent.output } : {}),
              timestamp: Date.now(),
            });
          },
    });

    // Save brand message to DB
    const brandMessage = await prisma.message.create({
      data: {
        roundId: round.id,
        role: "brand_agent",
        content: brandMessageContent,
      },
    });

    state.onEvent({
      type: "message",
      role: "brand_agent",
      supplierId: profile.id,
      supplierName: profile.name,
      content: brandMessageContent,
      roundNumber,
      phase: state.phase,
      messageId: brandMessage.id,
      timestamp: Date.now(),
    });

    const updatedHistory: MessageData[] = [
      ...history,
      { role: "brand_agent" as const, content: brandMessageContent },
    ];

    // Generate supplier response — inject curveball constraint for the affected supplier during post_curveball phase
    const curveball =
      state.curveballSupplierCode &&
      profile.code === state.curveballSupplierCode &&
      state.phase === "post_curveball"
        ? "Due to a raw material shortage, you can only fulfill ~60% of this order within the original timeline. The remaining 40% would need 3-4 extra weeks."
        : undefined;

    if (curveball) {
      console.log(
        `  [${profile.code}] CURVEBALL constraint injected at post_curveball round ${roundNumber}`,
      );
    }

    const supplierSystemPrompt = buildSupplierSystemPrompt(
      profile,
      state.quotationItems,
      updatedHistory,
      curveball,
      isQuoteRequest,
      roundNumber,
      state.allOffers[profile.id] ?? null,
    );

    const supplierMessageContent = await createSupplierResponse(
      supplierSystemPrompt,
      updatedHistory,
      state.negotiationId,
    );

    const supplierMessage = await prisma.message.create({
      data: {
        roundId: round.id,
        role: "supplier_agent",
        content: supplierMessageContent,
      },
    });

    state.onEvent({
      type: "message",
      role: "supplier_agent",
      supplierId: profile.id,
      supplierName: profile.name,
      content: supplierMessageContent,
      roundNumber,
      phase: state.phase,
      messageId: supplierMessage.id,
      timestamp: Date.now(),
    });

    const finalHistory: MessageData[] = [
      ...updatedHistory,
      { role: "supplier_agent" as const, content: supplierMessageContent },
    ];

    // Extract offer
    const offer = await extractOffer(
      supplierMessageContent,
      profile,
      state.quotationItems,
      state.negotiationId,
    );

    await prisma.negotiationRound.update({
      where: { id: round.id },
      data: {
        offerData: JSON.parse(JSON.stringify({
          ...offer,
          _contextSections: capturedContextSections ?? null,
          _contextSummary: capturedContextSummary ?? null,
          _pillarOutputs: Object.keys(capturedPillarOutputs).length > 0 ? capturedPillarOutputs : null,
        })),
        status: "completed",
      },
    });

    state.onEvent({
      type: "offer_extracted",
      supplierId: profile.id,
      roundNumber,
      offer,
      timestamp: Date.now(),
    });

    const roundElapsed = Date.now() - roundStartTime;
    console.log(
      `  [${profile.code}] Round ${roundNumber} complete in ${roundElapsed}ms — offer: $${offer.totalCost.toLocaleString()}`,
    );

    state.onEvent({
      type: "round_end",
      supplierId: profile.id,
      roundNumber,
      timestamp: Date.now(),
    });

    return {
      supplierId: profile.id,
      offer,
      history: finalHistory,
    };
  }; // end processSupplier

  // Process results
  const newOffers: Record<string, OfferData> = {};
  const newHistories: Record<string, MessageData[]> = {};
  const newPreviousOffers: Record<string, OfferData> = {};

  const processResults = (
    results: PromiseSettledResult<{
      supplierId: string;
      offer: OfferData;
      history: MessageData[];
    }>[],
    suppliers: typeof activeSuppliers,
  ) => {
    for (let i = 0; i < results.length; i++) {
      const profile = suppliers[i];
      const result = results[i];
      if (result.status === "fulfilled") {
        const { supplierId, offer, history } = result.value;
        newOffers[supplierId] = offer;
        newHistories[supplierId] = history;
        newPreviousOffers[supplierId] = offer;
      } else {
        console.error(
          `  [${profile.code}] Round ${roundNumber} failed: ${result.reason}`,
        );
        state.onEvent({
          type: "error",
          message: `Supplier ${profile.name} round ${roundNumber} failed: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
          timestamp: Date.now(),
        });
      }
    }
  };

  // Wave 1: Non-XLSX suppliers (or all suppliers if not R1 staged)
  const wave1Results = await Promise.allSettled(
    wave1Suppliers.map((profile) => processSupplier(profile, offersMap)),
  );
  processResults(wave1Results, wave1Suppliers);

  // Wave 2: XLSX supplier with updated offers (only in R1 staged mode)
  if (wave2Suppliers.length > 0) {
    // Rebuild offersMap with wave1 results so S1 sees S2/S3 offers as competitive intel
    offersMap = new Map([...offersMap, ...Object.entries(newOffers)]);
    console.log(
      `  [negotiation-graph] Wave 1 complete. S1 now has leverage from: ${wave1Suppliers.map((p) => p.code).join(", ")}`,
    );

    const wave2Results = await Promise.allSettled(
      wave2Suppliers.map((profile) => processSupplier(profile, offersMap)),
    );
    processResults(wave2Results, wave2Suppliers);
  }

  // Emit offers_snapshot with all current scored offers
  const mergedOffers = { ...state.allOffers, ...newOffers };
  const snapshotEntries = Object.entries(mergedOffers)
    .map(([supplierId, offer]) => {
      const profile = state.supplierProfiles.find((p) => p.id === supplierId);
      if (!profile) return null;
      return {
        supplierId,
        supplierName: profile.name,
        supplierCode: profile.code,
        offer: {
          totalCost: offer.totalCost,
          leadTimeDays: offer.leadTimeDays,
          paymentTerms: offer.paymentTerms,
        },
        profile: {
          qualityRating: profile.qualityRating,
          leadTimeDays: offer.leadTimeDays,
          paymentTerms: offer.paymentTerms,
        },
        isXlsxSource: profile.code === state.quotationSupplierCode,
        roundNumber,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  if (snapshotEntries.length > 0) {
    const scoredOffers = scoreAllOffers(snapshotEntries, state.mode);
    state.onEvent({
      type: "offers_snapshot",
      offers: scoredOffers,
      timestamp: Date.now(),
    } as SSEEvent);

    // Generate a brief round analysis for the UI slideshow
    const prevOffers = state.allOffers;
    const analyses: string[] = [];
    for (const scored of scoredOffers) {
      const prev = prevOffers[scored.supplierId];
      const costChange = prev ? scored.totalCost - prev.totalCost : 0;
      const costDir =
        costChange < 0
          ? `↓$${Math.abs(costChange).toLocaleString()}`
          : costChange > 0
            ? `↑$${costChange.toLocaleString()}`
            : "unchanged";
      const leadChange = prev ? scored.leadTimeDays - prev.leadTimeDays : 0;
      const leadDir =
        leadChange < 0
          ? `${leadChange}d faster`
          : leadChange > 0
            ? `+${leadChange}d slower`
            : "";
      analyses.push(
        `${scored.supplierName}: $${scored.totalCost.toLocaleString()} (${costDir})${leadDir ? `, ${leadDir}` : ""}, ${scored.paymentTerms}, score ${Math.round(scored.score.weighted)}/100`,
      );
    }
    const bestSupplier = [...scoredOffers].sort(
      (a, b) => b.score.weighted - a.score.weighted,
    )[0];
    const roundSummary = `Round ${roundNumber}: ${bestSupplier ? `${bestSupplier.supplierName} leads (${Math.round(bestSupplier.score.weighted)}/100)` : "Scores updated"}. ${analyses.join(" · ")}`;

    state.onEvent({
      type: "round_analysis",
      roundNumber,
      summary: roundSummary,
      supplierScores: scoredOffers.map((s) => ({
        supplierName: s.supplierName,
        supplierId: s.supplierId,
        totalCost: s.totalCost,
        leadTimeDays: s.leadTimeDays,
        paymentTerms: s.paymentTerms,
        weightedScore: Math.round(s.score.weighted),
        concessions: s.concessions,
      })),
      timestamp: Date.now(),
    } as SSEEvent);
  }

  return {
    allOffers: newOffers,
    conversationHistories: newHistories,
    previousOffers: newPreviousOffers,
    currentRound: roundNumber + 1,
  };
}

// ─── Node: Check Convergence ────────────────────────────────────────────────

async function checkConvergenceNode(
  state: typeof NegotiationGraphState.State,
): Promise<Partial<typeof NegotiationGraphState.State>> {
  const maxRounds = state.maxRounds || MAX_ROUNDS;

  if (state.currentRound > maxRounds) {
    console.log(
      `  [negotiation-graph] Max rounds (${maxRounds}) reached. Ending.`,
    );
    for (const profile of state.supplierProfiles) {
      state.onEvent({
        type: "supplier_complete",
        supplierId: profile.id,
        timestamp: Date.now(),
      });
    }
    return { isComplete: true };
  }

  console.log(
    `  [negotiation-graph] ${state.supplierProfiles.length} suppliers continuing to round ${state.currentRound}...`,
  );
  return { isComplete: false };
}

// ─── Routing ────────────────────────────────────────────────────────────────

function shouldContinue(
  state: typeof NegotiationGraphState.State,
): "negotiateRound" | typeof END {
  return state.isComplete ? END : "negotiateRound";
}

// ─── Build & Compile Graph ──────────────────────────────────────────────────

const negotiationGraphBuilder = new StateGraph(NegotiationGraphState)
  .addNode("initSuppliers", initSuppliersNode)
  .addNode("negotiateRound", negotiateRoundNode)
  .addNode("checkConvergence", checkConvergenceNode)
  .addEdge(START, "initSuppliers")
  .addEdge("initSuppliers", "negotiateRound")
  .addEdge("negotiateRound", "checkConvergence")
  .addConditionalEdges("checkConvergence", shouldContinue, {
    negotiateRound: "negotiateRound",
    [END]: END,
  });

export const negotiationGraph = negotiationGraphBuilder.compile();
