/**
 * OFFER EXTRACTOR - Structured Data Extraction from Supplier Messages
 *
 * Purpose: Convert free-form supplier negotiation messages into structured offers
 *
 * Input: Supplier's natural language response (e.g., "I can do $85/unit on the jackets...")
 * Output: Structured OfferData with:
 *   - totalCost (number)
 *   - items[] (sku, unitPrice, quantity, optional volumeTiers)
 *   - leadTimeDays (number)
 *   - paymentTerms (string)
 *   - concessions[] (what they gave up)
 *   - conditions[] (strings attached)
 *
 * Zod Schema: Enforces type safety + validation at extraction time
 *
 * Key Features:
 *   1. Deterministic totalCost calculation (NEVER trust LLM arithmetic)
 *      → Computes from items: SUM(unitPrice × quantity)
 *   2. Backfills missing items from baseline quotation
 *      → If supplier only mentions some SKUs, assumes others unchanged
 *   3. Retry with fallback on validation failure
 *      → Relaxes constraints if initial extraction fails
 *   4. Volume tier extraction (optional)
 *      → Captures "Qty 1000+: $82/unit" type offers
 *
 * Model: Claude Haiku via Vercel AI SDK generateObject() (Zod validation built-in)
 * Called after: Every supplier response
 */

import { generateObject } from "ai";
import { z } from "zod";
import { extractorModel, getCostTracker } from "../lib/ai";
import { formatSkuRef } from "./format-helpers";
import type { OfferData, QuotationItemData, SupplierProfile } from "./types";
import { computePriceRange } from "./utils/calculations";
import { formatCurrency } from "./utils/formatting";

const volumeTierSchema = z.object({
  minQty: z.number().describe("Minimum quantity for this tier (inclusive)"),
  maxQty: z.number().nullable().describe("Maximum quantity for this tier (inclusive), or null if no upper limit"),
  unitPrice: z.number().describe("Unit price at this quantity tier"),
});

const offerSchema = z.object({
  totalCost: z
    .number()
    .describe("Total cost of the offer across all items (sum of unitPrice * quantity for each item)"),
  items: z
    .array(
      z.object({
        sku: z.string().describe("Product SKU"),
        unitPrice: z.number().describe("Price per unit offered at the baseline quantity"),
        quantity: z.number().describe("Quantity for this item (use baseline quantity)"),
        volumeTiers: z
          .array(volumeTierSchema)
          .optional()
          .describe("Volume-based pricing tiers for this item, if the supplier mentioned quantity-dependent pricing. Include the baseline qty tier as well."),
      }),
    )
    .describe("Per-item pricing breakdown"),
  leadTimeDays: z
    .number()
    .describe("Delivery lead time in days"),
  paymentTerms: z
    .string()
    .describe("Payment terms offered (e.g., '40/60', '100% upfront', '33/33/33')"),
  concessions: z
    .array(z.string())
    .describe("List of concessions offered (discounts, free shipping, etc.)"),
  conditions: z
    .array(z.string())
    .describe("List of conditions or requirements attached to the offer"),
});

function buildExtractionPrompt(
  supplierMessage: string,
  profile: SupplierProfile,
  quotationItems: QuotationItemData[],
): string {
  const baselineTotal = quotationItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const itemsList = quotationItems
    .map((item) => {
      let line = `  - ${formatSkuRef(item.rawSku, item.rawDescription)} (qty ${item.quantity}): baseline unit price $${item.unitPrice.toFixed(2)}, baseline total $${item.totalPrice.toFixed(2)}`;
      if (item.tiers && item.tiers.length > 1) {
        for (const tier of item.tiers) {
          if (tier.quantity === item.quantity) continue;
          line += `\n      Volume tier: Qty ${tier.quantity.toLocaleString()} → $${tier.unitPrice.toFixed(2)}/unit ($${tier.totalPrice.toFixed(2)} total)`;
        }
      }
      return line;
    })
    .join("\n");

  return `<role>You are a structured data extraction specialist. Extract a structured offer from a supplier's negotiation message.</role>

<supplier_info>
Supplier: ${profile.name} (${profile.code})
Default lead time: ${profile.leadTimeDays} days
Default payment terms: ${profile.paymentTerms}
</supplier_info>

<baseline_quotation>
${itemsList}
Baseline total: $${baselineTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}
</baseline_quotation>

<supplier_message>
${supplierMessage}
</supplier_message>

<instructions>
Extract the structured offer from the supplier message above. Follow these rules:

1. TOTAL COST (most important field): Calculate as sum of (unitPrice × quantity) for all items.
   - If specific per-unit prices are mentioned, multiply each by the baseline quantity and sum.
   - If a percentage discount is mentioned (e.g., "5% off"), apply to baseline total ($${baselineTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}).
   - If a total dollar amount is mentioned, use it directly.
   - totalCost must NEVER be 0. If pricing is unclear, estimate from baseline with stated discount.

2. ITEMS: Extract per-item unit prices. ALWAYS use BASELINE quantities (Qty column) for every item — this is non-negotiable for apples-to-apples comparison. If the supplier proposes different quantities, still use baseline quantities and extract their unit price at those quantities.

3. LEAD TIME & PAYMENT TERMS: Use the supplier's stated values. Fall back to defaults if not mentioned.

4. CONCESSIONS: Any discounts, free services, warranties, expedited QA, etc. (NOT volume tiers — those go in volumeTiers).

5. CONDITIONS: Any requirements attached to the offer (minimum order, upfront payment, etc.).

6. VOLUME TIERS (per item): If the supplier mentions tiered/volume pricing for any item, extract structured volumeTiers on that item:
   - Each tier: { minQty, maxQty (null if no upper limit), unitPrice }
   - ALWAYS include the baseline quantity tier (the price at the requested quantity)
   - If no volume discounts mentioned, leave volumeTiers empty/undefined
   - Example: "500 units at $12/ea, 1000+ at $10/ea" → [{ minQty: 500, maxQty: 999, unitPrice: 12 }, { minQty: 1000, maxQty: null, unitPrice: 10 }]
   - The main unitPrice field should still reflect the BASELINE quantity price
</instructions>`;
}

export async function extractOffer(
  supplierMessage: string,
  supplierProfile: SupplierProfile,
  quotationItems: QuotationItemData[] = [],
  negotiationId?: string,
): Promise<OfferData> {
  const startTime = Date.now();
  console.log(
    `offer-extractor: Extracting offer from ${supplierProfile.name} (Haiku)...`,
  );

  const prompt = buildExtractionPrompt(supplierMessage, supplierProfile, quotationItems);

  let object: z.infer<typeof offerSchema>;

  try {
    const result = await generateObject({
      model: extractorModel,
      schema: offerSchema,
      prompt,
    });
    object = result.object;
    if (negotiationId && result.usage) {
      getCostTracker(negotiationId).track(
        "claude-haiku-4-5-20251001",
        result.usage.promptTokens,
        result.usage.completionTokens,
      );
    }
  } catch (firstError) {
    const firstElapsed = Date.now() - startTime;
    console.warn(
      `offer-extractor: First attempt failed for ${supplierProfile.name} after ${firstElapsed}ms, retrying...`,
    );

    try {
      const result = await generateObject({
        model: extractorModel,
        schema: offerSchema,
        prompt,
      });
      object = result.object;
      if (negotiationId && result.usage) {
        getCostTracker(negotiationId).track(
          "claude-haiku-4-5-20251001",
          result.usage.promptTokens,
          result.usage.completionTokens,
        );
      }
    } catch (retryError) {
      const elapsed = Date.now() - startTime;
      const message =
        retryError instanceof Error ? retryError.message : String(retryError);
      console.error(
        `offer-extractor: Both attempts failed for ${supplierProfile.name} after ${elapsed}ms: ${message}`,
      );

      // Return fallback using baseline
      const baselineTotal = quotationItems.reduce((sum, item) => sum + item.totalPrice, 0);
      console.log(
        `offer-extractor: Returning fallback offer with baseline total $${baselineTotal.toLocaleString()}`,
      );
      return {
        totalCost: baselineTotal,
        items: quotationItems.map((qi) => ({
          sku: qi.rawSku,
          unitPrice: qi.unitPrice,
          quantity: qi.quantity,
        })),
        leadTimeDays: supplierProfile.leadTimeDays,
        paymentTerms: supplierProfile.paymentTerms,
        concessions: [],
        conditions: [],
      };
    }
  }

  // ── Deterministic totalCost: never trust the LLM's arithmetic ──
  // If we have items with valid sku + qty + unitPrice, compute ourselves.
  const validItems = object.items.filter(
    (item) => item.sku && item.quantity > 0 && item.unitPrice > 0,
  );

  if (validItems.length > 0) {
    const computedTotal = validItems.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    );
    if (Math.abs(computedTotal - object.totalCost) > 1) {
      console.log(
        `offer-extractor: Overriding LLM totalCost ($${object.totalCost.toLocaleString()}) with computed ($${computedTotal.toLocaleString()}) for ${supplierProfile.name}`,
      );
    }
    object.totalCost = computedTotal;
  } else if (object.totalCost === 0 || object.totalCost < 1) {
    // No valid items and LLM returned $0 — fall back to baseline
    const baselineTotal = quotationItems.reduce((sum, item) => sum + item.totalPrice, 0);
    object.totalCost = baselineTotal;
    console.warn(
      `offer-extractor: No valid items + $0 totalCost for ${supplierProfile.name}, using baseline $${baselineTotal.toLocaleString()}`,
    );
  }

  // ── Validate against supplier price range ──
  const priceRange = computePriceRange(supplierProfile);
  const baselineTotal = quotationItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const minCost = baselineTotal * priceRange.low;
  const maxCost = baselineTotal * priceRange.high;

  // Clip total cost if outside range (with warning)
  if (object.totalCost < minCost || object.totalCost > maxCost) {
    console.warn(
      `offer-extractor: Supplier ${supplierProfile.name} quoted ${formatCurrency(object.totalCost)} outside allowed range [${formatCurrency(minCost)}, ${formatCurrency(maxCost)}]. Clipping to range.`
    );
    object.totalCost = Math.max(minCost, Math.min(maxCost, object.totalCost));

    // Proportionally adjust item prices to match clipped total
    const currentItemsTotal = object.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    if (currentItemsTotal > 0) {
      const adjustmentFactor = object.totalCost / currentItemsTotal;
      object.items = object.items.map(item => ({
        ...item,
        unitPrice: item.unitPrice * adjustmentFactor,
      }));
    }
  }

  // ── Detect per-item outliers (log warnings, don't clip) ──
  for (const item of object.items) {
    const baselineItem = quotationItems.find(
      q => q.rawSku?.toUpperCase() === item.sku.toUpperCase()
    );

    if (!baselineItem) {
      console.warn(`offer-extractor: Item ${item.sku} not found in baseline, may be hallucinated`);
      continue;
    }

    const itemPriceRatio = item.unitPrice / baselineItem.unitPrice;
    const itemMinRatio = priceRange.low * 0.85; // Allow 15% slack for item-level variance
    const itemMaxRatio = priceRange.high * 1.15;

    if (itemPriceRatio < itemMinRatio || itemPriceRatio > itemMaxRatio) {
      console.warn(
        `offer-extractor: Item ${item.sku} priced at ${itemPriceRatio.toFixed(2)}x baseline (outside ${itemMinRatio.toFixed(2)}-${itemMaxRatio.toFixed(2)}x range)`
      );
    }
  }

  // Backfill missing items from baseline quotation so downstream always has full SKU coverage
  if (validItems.length < quotationItems.length && quotationItems.length > 0) {
    const extractedSkus = new Set(validItems.map((i) => i.sku.toUpperCase()));
    for (const qi of quotationItems) {
      if (!extractedSkus.has(qi.rawSku.toUpperCase())) {
        object.items.push({
          sku: qi.rawSku,
          unitPrice: qi.unitPrice,
          quantity: qi.quantity,
        });
      }
    }
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `offer-extractor: Extracted from ${supplierProfile.name} in ${elapsed}ms — $${object.totalCost.toLocaleString()}, ${object.items.length} items, ${object.concessions.length} concessions`,
  );

  return object;
}
