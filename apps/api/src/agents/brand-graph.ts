/**
 * BRAND GRAPH - 3-Pillar Parallel Analysis (LangGraph StateGraph)
 *
 * Purpose: Decomposes Brand Agent into 3 specialists that analyze in PARALLEL,
 *          then synthesizes their insights into one coherent message
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │                    3 PILLARS (RUN IN PARALLEL)                       │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  NEGOTIATOR          │  RISK ANALYST       │  PRODUCT/COST           │
 * │  - Competitive       │  - Supply chain     │  - SKU-level pricing    │
 * │    bidding tactics   │    risk assessment  │  - Cash flow impact     │
 * │  - Leverage points   │  - Backup plans     │  - Volume tiers         │
 * │  - FOMO creation     │  - Diversification  │  - Landed cost calc     │
 * │  - Counter strategy  │  - Quality vs cost  │  - Payment terms        │
 * └──────────────────────┴─────────────────────┴─────────────────────────┘
 *                                    │
 *                                    ▼
 *                            ┌──────────────┐
 *                            │ SYNTHESIZER  │ → Merges all 3 outputs
 *                            │     Haiku    │   into single message
 *                            └──────────────┘   as "Alex"
 *
 * Flow: START ──┬─► negotiator ──┐
 *               ├─► riskAnalyst ─┤──► synthesizer ──► END
 *               └─► productCost ─┘
 *
 * Benefits: 70% token reduction (compact pillar contexts), specialized reasoning
 * Models: Claude Haiku (pillars + synthesizer) - fast, parallel-safe, avoids rate limits
 *
 * ── KEY POINTS ──────────────────────────────────────────────────
 *   • Graph inside a graph — outer orchestrates suppliers, inner orchestrates thinking
 *   • Three pillars run in parallel: ~6s wall-clock instead of ~18s sequential
 *   • Each pillar gets tailored compact context — 70% fewer tokens than a single blob
 *   • Synthesizer resolves inter-pillar conflicts into one message as "Alex"
 * ────────────────────────────────────────────────────────────────
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  haikuSemaphore,
  pillarModel,
  synthesizerModel,
  trackUsage,
  withSemaphore,
} from "../lib/ai";
import type { PillarContexts } from "./context-builder";
import type {
  MessageData,
  OfferData,
  QuotationItemData,
  SupplierProfile,
} from "./types";

const PILLAR_MODEL_ID = "claude-haiku-4-5-20251001";
const SYNTHESIZER_MODEL_ID = "claude-haiku-4-5-20251001";

// ─── State Annotation ────────────────────────────────────────────────────────

const BrandGraphState = Annotation.Root({
  // --- Inputs (set by caller, never mutated by nodes) ---
  negotiationId: Annotation<string>({
    reducer: (_, b) => b,
    default: () => "",
  }),
  currentSupplierId: Annotation<string>(),
  supplierName: Annotation<string>(),
  quotationItems: Annotation<QuotationItemData[]>(),
  supplierProfiles: Annotation<SupplierProfile[]>(),
  allOffers: Annotation<Map<string, OfferData>>(),
  conversationHistory: Annotation<MessageData[]>(),
  roundNumber: Annotation<number>(),
  totalRounds: Annotation<number>(),
  userNotes: Annotation<string>(),
  contextPrompt: Annotation<string>(), // full context-builder output (for synthesizer)
  pillarContexts: Annotation<PillarContexts | null>({
    reducer: (_, b) => b,
    default: () => null,
  }), // compact per-pillar contexts
  isXlsxSource: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }), // true if this is S1 (XLSX supplier)

  // --- Pillar outputs (each pillar writes its result) ---
  pillarOutputs: Annotation<Record<string, string>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),

  // --- Final synthesized message ---
  finalMessage: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "",
  }),
});

export type BrandGraphInput = typeof BrandGraphState.State;
export type BrandGraphOutput = typeof BrandGraphState.State;

// ─── Pillar Event Callback ──────────────────────────────────────────────────

export type PillarEventType = "pillar_started" | "pillar_complete";

export interface PillarEvent {
  type: PillarEventType;
  pillar: string;
  supplierId: string;
  roundNumber: number;
  output?: string;
}

// Global event callback (set per-invocation via config or direct assignment)
let _onPillarEvent: ((event: PillarEvent) => void) | null = null;

export function setOnPillarEvent(cb: ((event: PillarEvent) => void) | null) {
  _onPillarEvent = cb;
}

function emitPillar(event: PillarEvent) {
  if (_onPillarEvent) _onPillarEvent(event);
}

// ─── Pillar 1: Negotiator ───────────────────────────────────────────────────

async function negotiatorNode(
  state: typeof BrandGraphState.State,
): Promise<Partial<typeof BrandGraphState.State>> {
  const startTime = Date.now();
  const pillarName = "negotiator";

  emitPillar({
    type: "pillar_started",
    pillar: pillarName,
    supplierId: state.currentSupplierId,
    roundNumber: state.roundNumber,
  });

  console.log(
    `  [brand-graph] Pillar 1 (Negotiator) started for ${state.supplierName}`,
  );

  const context = state.pillarContexts?.negotiator ?? state.contextPrompt;

  const prompt = `<role>You are the Negotiation Specialist on a procurement team. Your job is to produce a negotiation strategy brief.</role>

<context>
${context}
</context>

<instructions>
Analyze the current negotiation state and produce a 2-3 paragraph strategy brief focused on Competitive Bidding & Leverage:

- Identify the strongest leverage points from competing offers.
- Craft specific counter-offer language using exact numbers from competing bids.
- Create urgency and FOMO ("I'm making a decision today...").
- Suggest specific price targets, lead time asks, and payment term demands.
- If this is the opening round, set the competitive tone immediately.
- If this is a later round, escalate pressure using movement (or lack thereof) from prior rounds.
- If a supplier proposes volume-based discounts, evaluate whether the increased commitment actually creates net savings. Only pursue volume leverage if the per-unit savings × extra units outweighs the additional inventory carrying cost and demand risk. Be skeptical of "order more to save" tactics that inflate total spend.

Include specific dollar amounts, percentages, and competing offer references. Do NOT write the actual supplier message — only the internal strategy brief for the lead negotiator.
</instructions>`;

  try {
    const response = await withSemaphore(haikuSemaphore, () =>
      pillarModel.invoke([
        new SystemMessage(prompt),
        new HumanMessage(
          state.conversationHistory.length === 0
            ? "This is the opening round. Provide the opening negotiation strategy."
            : `Latest supplier message: "${state.conversationHistory[state.conversationHistory.length - 1]?.content ?? ""}"`,
        ),
      ]),
    );

    if (state.negotiationId)
      trackUsage(state.negotiationId, PILLAR_MODEL_ID, response);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const elapsed = Date.now() - startTime;
    console.log(`  [brand-graph] Pillar 1 (Negotiator) done in ${elapsed}ms`);

    emitPillar({
      type: "pillar_complete",
      pillar: pillarName,
      supplierId: state.currentSupplierId,
      roundNumber: state.roundNumber,
      output: text.slice(0, 1500),
    });

    return { pillarOutputs: { [pillarName]: text } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [brand-graph] Pillar 1 failed: ${message}`);
    return {
      pillarOutputs: {
        [pillarName]: `[Negotiator pillar failed: ${message}. Fall back to general competitive pressure.]`,
      },
    };
  }
}

// ─── Pillar 2: Risk Analyst ─────────────────────────────────────────────────

async function riskAnalystNode(
  state: typeof BrandGraphState.State,
): Promise<Partial<typeof BrandGraphState.State>> {
  const startTime = Date.now();
  const pillarName = "riskAnalyst";

  emitPillar({
    type: "pillar_started",
    pillar: pillarName,
    supplierId: state.currentSupplierId,
    roundNumber: state.roundNumber,
  });

  console.log(
    `  [brand-graph] Pillar 2 (Risk Analyst) started for ${state.supplierName}`,
  );

  const context = state.pillarContexts?.riskAnalyst ?? state.contextPrompt;

  const prompt = `<role>You are the Risk Analyst on a procurement team. Your job is to assess supplier reliability, supply chain risks, AND pricing anomalies.</role>

<context>
${context}
</context>

<instructions>
Produce a concise risk assessment (1-2 paragraphs) focused on Proactive Risk Management:

- Assess this supplier's on-time delivery rate, defect rate, and lead time reliability.
- Compare risk metrics against other available suppliers with specific numbers.
- Identify concentration risk if allocating too much to one supplier.
- Flag any red flags (low on-time rate, high defect rate, long lead times).
- Recommend whether to push for multi-supplier strategy or single-source.
- If a curveball has occurred, assess its impact and recommend contingency actions.
- **CRITICAL: Flag significant price discrepancies.** If one supplier's total is 2x+ another's, investigate whether they are quoting the same quantities/scope. A $7M vs $700K quote is a red flag — likely different unit counts or added items. The negotiator MUST demand an apples-to-apples comparison on the same quantities before proceeding.

Reference exact percentages, days, and dollar amounts. Suggest what risk-related points the lead negotiator should raise. Do NOT write the actual supplier message.
</instructions>`;

  try {
    const response = await withSemaphore(haikuSemaphore, () =>
      pillarModel.invoke([
        new SystemMessage(prompt),
        new HumanMessage(
          state.conversationHistory.length === 0
            ? "Opening round. Provide initial risk assessment for this supplier."
            : `Current round ${state.roundNumber}. Assess ongoing risks.`,
        ),
      ]),
    );

    if (state.negotiationId)
      trackUsage(state.negotiationId, PILLAR_MODEL_ID, response);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const elapsed = Date.now() - startTime;
    console.log(`  [brand-graph] Pillar 2 (Risk Analyst) done in ${elapsed}ms`);

    emitPillar({
      type: "pillar_complete",
      pillar: pillarName,
      supplierId: state.currentSupplierId,
      roundNumber: state.roundNumber,
      output: text.slice(0, 1500),
    });

    return { pillarOutputs: { [pillarName]: text } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [brand-graph] Pillar 2 failed: ${message}`);
    return {
      pillarOutputs: {
        [pillarName]: `[Risk Analyst pillar failed: ${message}. Proceed with caution.]`,
      },
    };
  }
}

// ─── Pillar 3: Product/Cost Specialist ──────────────────────────────────────

async function productCostNode(
  state: typeof BrandGraphState.State,
): Promise<Partial<typeof BrandGraphState.State>> {
  const startTime = Date.now();
  const pillarName = "productCost";

  emitPillar({
    type: "pillar_started",
    pillar: pillarName,
    supplierId: state.currentSupplierId,
    roundNumber: state.roundNumber,
  });

  console.log(
    `  [brand-graph] Pillar 3 (Product/Cost) started for ${state.supplierName}`,
  );

  const context = state.pillarContexts?.productCost ?? state.contextPrompt;

  const prompt = `<role>You are the Product & Cost Specialist on a procurement team. Your job is to analyze pricing at the SKU level and total landed cost.</role>

<context>
${context}
</context>

<instructions>
Produce a concise financial analysis (1-2 paragraphs) focused on Technical & Financial Analysis:

- Identify pricing anomalies at the SKU level (items priced significantly above/below baseline).
- Calculate effective landed cost including cash flow impact (8% annual rate).
- Compare 100% upfront vs split payment terms on total cost of capital.
- Highlight which specific SKUs offer the best/worst value.
- Factor in lead time's impact on inventory carrying costs.
- Provide specific dollar amounts the negotiator should target per-SKU.

Include specific SKU references, dollar amounts, and cash flow calculations. Focus on numbers the lead negotiator can cite in conversation. Do NOT write the actual supplier message.
</instructions>`;

  try {
    const response = await withSemaphore(haikuSemaphore, () =>
      pillarModel.invoke([
        new SystemMessage(prompt),
        new HumanMessage(
          state.conversationHistory.length === 0
            ? "Opening round. Provide initial cost/product analysis."
            : `Round ${state.roundNumber}. Update cost analysis based on latest offers.`,
        ),
      ]),
    );

    if (state.negotiationId)
      trackUsage(state.negotiationId, PILLAR_MODEL_ID, response);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const elapsed = Date.now() - startTime;
    console.log(`  [brand-graph] Pillar 3 (Product/Cost) done in ${elapsed}ms`);

    emitPillar({
      type: "pillar_complete",
      pillar: pillarName,
      supplierId: state.currentSupplierId,
      roundNumber: state.roundNumber,
      output: text.slice(0, 1500),
    });

    return { pillarOutputs: { [pillarName]: text } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [brand-graph] Pillar 3 failed: ${message}`);
    return {
      pillarOutputs: {
        [pillarName]: `[Product/Cost pillar failed: ${message}. Use baseline numbers.]`,
      },
    };
  }
}

// ─── Synthesizer ────────────────────────────────────────────────────────────

async function synthesizerNode(
  state: typeof BrandGraphState.State,
): Promise<Partial<typeof BrandGraphState.State>> {
  const startTime = Date.now();

  console.log(
    `  [brand-graph] Synthesizer merging ${Object.keys(state.pillarOutputs).length} pillar outputs for ${state.supplierName}`,
  );

  const negotiatorBrief =
    state.pillarOutputs.negotiator ?? "(no negotiation strategy)";
  const riskBrief = state.pillarOutputs.riskAnalyst ?? "(no risk assessment)";
  const productBrief = state.pillarOutputs.productCost ?? "(no cost analysis)";

  // Build a trimmed conversation context — only last 2 messages for the synthesizer
  // (pillars already analyzed the full history)
  const recentHistory =
    state.conversationHistory.length <= 2
      ? state.conversationHistory
      : state.conversationHistory.slice(-2);
  const historyText =
    recentHistory.length === 0
      ? "(Opening message — no prior conversation)"
      : recentHistory
          .map(
            (m) =>
              `${m.role === "brand_agent" ? "You" : "Supplier"}: ${m.content}`,
          )
          .join("\n");

  // Build tier summary for S1 opening
  let tierSummary = "";
  const hasAnyTiers = state.quotationItems.some(
    (i) => i.tiers && i.tiers.length > 1,
  );
  if (state.isXlsxSource && hasAnyTiers) {
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
    const sortedTiers = Array.from(tierTotals.entries()).sort(
      ([a], [b]) => a - b,
    );
    tierSummary = sortedTiers
      .map(
        ([qty, total]) =>
          `Qty ${qty.toLocaleString()}: $${total.toLocaleString()}`,
      )
      .join(" | ");
  }

  const openingGuidance =
    state.conversationHistory.length === 0
      ? state.isXlsxSource
        ? `This is the XLSX SOURCE supplier — they already submitted the quote. For the OPENING message:
- Acknowledge their quote professionally. Reference the EXACT pricing tiers they submitted: ${tierSummary || "see cost analysis"}.
- Do NOT push for price reductions yet — you have no competing offers to leverage.
- Instead, ask clarifying questions about lead time, payment terms, and volume commitments.
- Only in LATER rounds (after you have competing bids) should you use leverage to negotiate price.
- Keep it warm and appreciative — they submitted the quote first.`
        : "Opening message. Introduce yourself as Alex from Valden Outdoor, then set competitive expectations."
      : state.isXlsxSource &&
          state.roundNumber <= 2 &&
          state.allOffers.size <= 1
        ? "Respond to the supplier. You are still gathering competing bids — do NOT push aggressively on price yet. Focus on terms, lead time, and relationship building."
        : "Respond to the supplier's latest message. Acknowledge briefly, then push forward.";

  const synthesisPrompt = `<role>You are Alex, procurement specialist at Valden Outdoor. Round ${state.roundNumber}/${state.totalRounds} with ${state.supplierName}.</role>

<negotiation_strategy>
${negotiatorBrief}
</negotiation_strategy>

<risk_assessment>
${riskBrief}
</risk_assessment>

<cost_analysis>
${productBrief}
</cost_analysis>

<latest_exchange>
${historyText}
</latest_exchange>

${state.userNotes ? `<internal_priorities>${state.userNotes}</internal_priorities>` : ""}

<instructions>
Merge the three analyses into ONE negotiation message as Alex.
${openingGuidance}

CRITICAL FORMAT RULES:
- MAXIMUM 80-100 words. One short paragraph. This is a fast-paced negotiation, not an essay.
- Use specific numbers from the analyses (dollar amounts, SKUs, lead times, terms).
- NEVER reveal competitor names — say "another supplier" or "a competing bid".
- NEVER reveal internal quality scores, ratings, or supplier performance metrics (e.g., "4/5 quality", "on-time delivery rate 92%"). These are confidential internal assessments. You may IMPLY quality perception naturally (e.g., "we appreciate your track record" or "quality consistency is important to us") but NEVER cite specific numbers or scores.
- NEVER reveal internal priorities verbatim.
- Sound natural and conversational — like a real procurement professional, not a robot reading a scorecard.
- NEVER use email-style formatting: no "Subject:" lines, no "RE:" prefixes, no email headers. This is a live negotiation chat, not email correspondence.
- NEVER use markdown bold (**text**) or other markup. Write plain, clean text.
- End with a clear, specific ask.
</instructions>`;

  try {
    const response = await withSemaphore(haikuSemaphore, () =>
      synthesizerModel.invoke([
        new SystemMessage(synthesisPrompt),
        new HumanMessage(
          state.conversationHistory.length === 0
            ? "Write your opening message as Alex. Keep it under 100 words."
            : "Write your next negotiation message. Keep it under 100 words.",
        ),
      ]),
    );

    if (state.negotiationId)
      trackUsage(state.negotiationId, SYNTHESIZER_MODEL_ID, response);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const elapsed = Date.now() - startTime;
    console.log(
      `  [brand-graph] Synthesizer done in ${elapsed}ms (${text.length} chars)`,
    );

    return { finalMessage: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [brand-graph] Synthesizer failed: ${message}`);
    throw new Error(`Brand graph synthesizer failed: ${message}`);
  }
}

// ─── Build & Compile Graph ──────────────────────────────────────────────────

const brandGraphBuilder = new StateGraph(BrandGraphState)
  // Parallel pillar nodes
  .addNode("negotiator", negotiatorNode)
  .addNode("riskAnalyst", riskAnalystNode)
  .addNode("productCost", productCostNode)
  // Synthesizer
  .addNode("synthesizer", synthesizerNode)
  // Fan-out: START → all 3 pillars in parallel
  .addEdge(START, "negotiator")
  .addEdge(START, "riskAnalyst")
  .addEdge(START, "productCost")
  // Fan-in: all 3 pillars → synthesizer
  .addEdge("negotiator", "synthesizer")
  .addEdge("riskAnalyst", "synthesizer")
  .addEdge("productCost", "synthesizer")
  // Synthesizer → END
  .addEdge("synthesizer", END);

export const brandGraph = brandGraphBuilder.compile();
