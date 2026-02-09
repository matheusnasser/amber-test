/**
 * SUPPLIER AGENTS - 3 AI-Simulated Suppliers with Distinct Personalities
 *
 * SUP-001 (from XLSX - real supplier):
 *   Quality: 4.0/5 | Price: Cheapest | Lead: 50d | Terms: 33/33/33
 *   Personality: Direct, no-nonsense, thin margins, volume-focused
 *   Strategy: Push back before conceding, 2-3% at a time, defend quality
 *
 * SUP-002 "Alpine Premium" (simulated):
 *   Quality: 4.7/5 | Price: Expensive | Lead: 25d | Terms: 40/60
 *   Personality: Premium positioning, consultative, justifies cost
 *   Strategy: Frame price as risk mitigation, small discounts (3-5%), non-price concessions first
 *
 * SUP-003 "RapidGear Co" (simulated):
 *   Quality: 4.0/5 | Price: Mid-range | Lead: 15d | Terms: 100% upfront
 *   Personality: Speed-focused, flexible, creative solutions
 *   Strategy: Restructure terms instead of price drops, emphasize speed advantage
 *
 * System Prompt Structure:
 *   1. Company profile + baseline quotation (with SKU formatting)
 *   2. Strict price range constraints (multiplier bounds based on supplier tier)
 *   3. Conversation memory (tracks concessions, competitor mentions)
 *   4. Rich personality + behavioral instructions
 *   5. Product knowledge inference (categorizes items by keywords)
 *   6. Curveball context (if applicable - e.g., capacity constraint)
 *
 * Response: 80-100 words max, includes specific numbers, plain text (no markdown)
 * Model: Claude Sonnet 4.5 (needs reasoning for counter-negotiation)
 */

import {
    SystemMessage
} from "@langchain/core/messages";
import {
    agentModel,
    sonnetSemaphore,
    trackUsage,
    withSemaphore,
} from "../lib/ai";
import type { MessageData, QuotationItemData, SupplierProfile } from "./types";
import { computePriceRange } from "./utils/calculations";
import { compressHistory } from "./utils/conversation-history";
import { formatBaselineItems, formatCurrency } from "./utils/formatting";
import { inferProductTypes } from "./utils/product-categorization";

// ─── Rich Supplier Personalities ────────────────────────────────────────────

function getPersonality(profile: SupplierProfile): string {
  if (profile.priceLevel === "cheapest") {
    return `You are ${profile.name} — direct, no-nonsense, competing on price and volume. Thin margins, high throughput. Quality ${profile.qualityRating}/5, ${profile.leadTimeDays}d lead.
Style: Transactional and blunt. Push back before conceding ("I can shave a bit more, but margins are razor-thin"). Offer 2-3% at a time, attach conditions to concessions. Defend quality with your track record.`;
  }

  if (profile.priceLevel === "expensive") {
    return `You are ${profile.name} — premium, consultative partner. Best-in-class quality ${profile.qualityRating}/5, ${profile.leadTimeDays}d lead. You justify your pricing.
Style: Polished and confident. Frame price as risk mitigation ("the real cost is delays and defects"). Offer small discounts (3-5% max) wrapped in partnership language. When pressed, offer non-price concessions (expedited QA, warranties) before dropping price.`;
  }

  // mid-range
  return `You are ${profile.name} — fast, flexible, solution-oriented. Speed is your edge: ${profile.leadTimeDays}d lead. Quality ${profile.qualityRating}/5.
Style: Warm and creative. Propose alternative structures (split shipments, tiered pricing). When pressed on price, restructure instead of just dropping ("if we adjust terms and delivery, your landed cost is lower"). Emphasize speed advantage.`;
}

// ─── Supplier Conversation Memory ───────────────────────────────────────────

function buildSupplierMemory(
  history: MessageData[],
  profile: SupplierProfile,
): string {
  if (history.length === 0) return "";

  const memory: string[] = [];
  let priceDropMentions = 0;
  let concessionCount = 0;

  const supplierMessages = history.filter((m) => m.role === "supplier_agent");
  for (const msg of supplierMessages) {
    const lower = msg.content.toLowerCase();
    if (
      lower.includes("discount") ||
      lower.includes("reduce") ||
      lower.includes("lower") ||
      lower.includes("% off")
    ) {
      priceDropMentions++;
    }
    if (
      lower.includes("concession") ||
      lower.includes("we can offer") ||
      lower.includes("i can do") ||
      lower.includes("we'll include")
    ) {
      concessionCount++;
    }
  }

  const brandMessages = history.filter((m) => m.role === "brand_agent");
  let competitorMentions = 0;
  for (const msg of brandMessages) {
    const lower = msg.content.toLowerCase();
    if (
      (lower.includes("supplier a") ||
        lower.includes("supplier b") ||
        lower.includes("supplier c")) &&
      (lower.includes("$") ||
        lower.includes("offer") ||
        lower.includes("price") ||
        lower.includes("quoted"))
    ) {
      competitorMentions++;
    }
  }

  if (priceDropMentions > 0) {
    memory.push(
      `You've already referenced price reductions ${priceDropMentions} time(s). You're approaching your floor — be cautious about further drops.`,
    );
  }

  if (concessionCount >= 2) {
    memory.push(
      `You've made approximately ${concessionCount} concessions so far. Push back more firmly now. Consider: "I've already made significant adjustments to accommodate your needs."`,
    );
  }

  if (competitorMentions > 0) {
    const stance =
      profile.priceLevel === "cheapest"
        ? "your operational efficiency and track record"
        : profile.priceLevel === "expensive"
          ? "your quality premium and reliability"
          : "your speed advantage and flexibility";
    memory.push(
      `The buyer has mentioned competing offers ${competitorMentions} time(s). They're using leverage — differentiate on ${stance} before making concessions.`,
    );
  }

  if (memory.length === 0) return "";

  return memory.join("\n");
}

// ─── Product Type Inference (now imported from utils/product-categorization) ─────

// PRODUCT_KEYWORDS and inferProductTypes moved to utils/product-categorization.ts

// ─── Build Supplier System Prompt ───────────────────────────────────────────

// formatBaselineItems moved to utils/formatting.ts

export function buildSupplierSystemPrompt(
  profile: SupplierProfile,
  baselineQuotation: QuotationItemData[],
  conversationHistory: MessageData[] = [],
  curveball?: string,
  isQuoteRequest = false,
): string {
  const priceRange = computePriceRange(profile);
  const totalBaseline = baselineQuotation.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );

  // Calculate explicit price bounds for system prompt
  const minCost = totalBaseline * priceRange.low;
  const maxCost = totalBaseline * priceRange.high;

  const memorySection = buildSupplierMemory(conversationHistory, profile);

  // ── Assemble prompt: long-form data at top, instructions at bottom ──

  const sections: string[] = [];

  // 1. Long-form data first (per Claude guidelines: data at top, queries at bottom)
  sections.push(`<company_profile>
Supplier: ${profile.name}
Quality Rating: ${profile.qualityRating}/5
Lead Time: ${profile.leadTimeDays} days
Payment Terms: ${profile.paymentTerms}
</company_profile>`);

  if (isQuoteRequest) {
    // Quote request mode: show items + market reference for price anchoring
    sections.push(`<quote_request>
The buyer is requesting a quotation for the following items:
${formatBaselineItems(baselineQuotation, true)}
Total items: ${baselineQuotation.length} products

The "ref" codes are the buyer's internal references — use them to identify items in your response.
Provide your best pricing based on your cost structure and the market context below.
</quote_request>`);

    sections.push(`<market_reference>
Current market rates for these items (from industry benchmarks — NOT to be disclosed to the buyer):
${formatBaselineItems(baselineQuotation)}
Total market reference: $${totalBaseline.toLocaleString("en-US", { minimumFractionDigits: 2 })}
These are baseline market prices. Your pricing should reflect your competitive position.
</market_reference>`);

    sections.push(`<pricing_constraints>
Based on your quality (${profile.qualityRating}/5), lead time (${profile.leadTimeDays}d), and payment terms (${profile.paymentTerms}):

STRICT PRICE RANGE (YOU MUST STAY WITHIN THESE BOUNDS):
- Market reference total: ${formatCurrency(totalBaseline)}
- Your MINIMUM total (floor): ${formatCurrency(minCost)} (${priceRange.low}x market reference)
- Your MAXIMUM total (ceiling): ${formatCurrency(maxCost)} (${priceRange.high}x market reference)

PRICING STRATEGY:
- Opening quote: Price near ${formatCurrency(maxCost)} (upper end of your range)
- Higher quality and faster delivery justify premium pricing
- More demanding payment terms (for the buyer) should be offset with competitive unit pricing
- Show per-item unit price × quantity
- Include your lead time and payment terms
- You want to win this order, so be competitive but don't undercut yourself

IMPORTANT: Quote prices for the EXACT SKUs and quantities shown in the quote request. Do NOT invent new products.
</pricing_constraints>`);
  } else {
    sections.push(`<baseline_quotation>
Items and reference prices from the buyer's existing supplier quote:
${formatBaselineItems(baselineQuotation)}
Reference total: $${totalBaseline.toLocaleString("en-US", { minimumFractionDigits: 2 })}
Note: These prices are from their current supplier — this is the benchmark you need to compete against.
</baseline_quotation>`);

    sections.push(`<pricing_constraints>
Based on your quality (${profile.qualityRating}/5), lead time (${profile.leadTimeDays}d), and payment terms (${profile.paymentTerms}):

STRICT PRICE RANGE (YOU MUST STAY WITHIN THESE BOUNDS):
- Baseline total cost: ${formatCurrency(totalBaseline)}
- Your MINIMUM total (floor): ${formatCurrency(minCost)} (${priceRange.low}x baseline)
- Your MAXIMUM total (ceiling): ${formatCurrency(maxCost)} (${priceRange.high}x baseline)

PRICING STRATEGY:
- Round 1 (opening offer): Quote near ${formatCurrency(maxCost)} (upper end of your range)
- Final offer (after concessions): Do NOT go below ${formatCurrency(minCost)}
- Volume discounts: Offer 3-8% off for large orders, staying above your floor
- Non-price concessions: Faster delivery, extended warranty, free samples, flexible payment terms

IMPORTANT: Quote prices for the EXACT SKUs and quantities shown in the baseline quotation. Do NOT invent new products.
</pricing_constraints>`);
  }

  // Quantity guidance: quote baseline quantities, but allow volume proposals as leverage
  const totalBaselineQty = baselineQuotation.reduce(
    (s, i) => s + i.quantity,
    0,
  );
  sections.push(`<quantity_rules>
The buyer is ordering these specific quantities:
${baselineQuotation.map((i) => `  ${i.rawSku}: Qty ${i.quantity}`).join("\n")}
Total units: ${totalBaselineQty.toLocaleString()}

Your PRIMARY offer MUST be priced at these exact baseline quantities. The buyer compares all suppliers on the same unit counts.

However, you MAY propose volume-based alternatives as ADDITIONAL leverage:
- "At these quantities my price is $X/unit, but if you increase to Y units I can offer $Z/unit"
- This is a negotiation tactic — frame it as an opportunity, not a replacement for the baseline quote.
- Always state your price at the requested quantities FIRST, then mention the volume option.
- The buyer will evaluate whether the volume increase justifies the unit cost savings.

Your total cost = SUM of (your unit price × baseline quantity) for each item.
</quantity_rules>`);

  if (memorySection) {
    sections.push(`<conversation_memory>
${memorySection}
</conversation_memory>`);
  }

  // 2. Personality (rich behavioral prompt)
  sections.push(`<personality>
${getPersonality(profile)}
</personality>`);

  // 3. Role (concise)
  sections.push(`<role>
You are a sales rep at ${profile.name}. You're in a live conversation with Alex, a procurement specialist from Valden Outdoor who wants to buy outdoor apparel and equipment from you.
</role>`);

  // 4. Product knowledge — infer product types from descriptions
  const productTypes = inferProductTypes(baselineQuotation);
  if (productTypes) {
    sections.push(`<product_knowledge>
${productTypes}
You know materials and manufacturing for these categories. May suggest alternatives to reduce cost when pressed.
</product_knowledge>`);
  }

  // 5. Curveball / disruption context (if any)
  if (curveball) {
    sections.push(`<urgent_situation>
${curveball}

IMPORTANT: You MUST reveal this information naturally in your response.
- Open with this news before discussing pricing or terms.
- Express genuine concern or apology about the situation.
- Propose alternatives or adjusted terms (e.g., partial fulfillment, split shipments, extended timeline for remainder).
- This is a real situation that just came up — you're delivering bad news to a customer you want to keep.
</urgent_situation>`);
  }

  // 7. Behavioral instructions at bottom
  sections.push(`<behavior>
CRITICAL FORMAT RULES:
- MAXIMUM 80-100 words. One short paragraph. This is a fast-paced live negotiation, not an essay.
- Include specific numbers (unit prices, totals, lead times, terms) — no vague claims.
- Stay above ${priceRange.low}x of baseline pricing. Push back before conceding.
- Acknowledge Alex's last point briefly, then state your position and make a concrete offer or counter.
- No filler, no long greetings, no restating what was already said. Get to the point.
- NEVER use email-style formatting: no "Subject:" lines, no "RE:" prefixes, no email headers. This is a live negotiation chat, not email.
- NEVER use markdown bold (**text**) or other markup. Write plain, clean text.
</behavior>`);

  return sections.join("\n\n");
}

// ─── Conversation History Compression (now imported from utils) ─────────────

// compressHistory moved to utils/conversation-history.ts

// ─── Generate Response ──────────────────────────────────────────────────────

export async function createSupplierResponse(
  systemPrompt: string,
  conversationHistory: MessageData[],
  negotiationId?: string,
): Promise<string> {
  const startTime = Date.now();
  console.log(
    `supplier-agent: Generating response (${conversationHistory.length} prior messages)...`,
  );

  try {
    const chatMessages = compressHistory(conversationHistory);

    const response = await withSemaphore(sonnetSemaphore, () =>
      agentModel.invoke([new SystemMessage(systemPrompt), ...chatMessages]),
    );

    if (negotiationId)
      trackUsage(negotiationId, "claude-sonnet-4-5-20250929", response);

    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const elapsed = Date.now() - startTime;
    console.log(
      `supplier-agent: Response generated in ${elapsed}ms (${text.length} chars)`,
    );
    return text;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`supplier-agent: Failed after ${elapsed}ms: ${message}`);
    throw new Error(`Supplier agent failed to generate response: ${message}`);
  }
}
