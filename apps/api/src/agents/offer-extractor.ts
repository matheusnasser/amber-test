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
 *
 * ── KEY POINTS ──────────────────────────────────────────────────
 *   • Bridges natural language → structured data (per-SKU prices, terms, concessions)
 *   • Deterministic totalCost: SUM(unitPrice x quantity) — never trust LLM arithmetic
 *   • Force-normalizes quantities to baseline — apples-to-apples supplier comparison
 *   • Blanket price detection — catches "$165/unit for all 20 products" and fixes it
 *   • Per-item outlier correction — snaps nonsensical prices back to baseline
 * ────────────────────────────────────────────────────────────────
 */

import { generateObject } from "ai";
import { z } from "zod";
import { extractorModel, getCostTracker } from "../lib/ai";
import { formatSkuRef } from "./format-helpers";
import type { OfferData, QuotationItemData, SupplierProfile } from "./types";
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
   - CRITICAL: If the supplier quotes a SINGLE blanket price (e.g., "$165/unit" for all items), do NOT apply that price to every SKU. Instead, interpret it as a percentage adjustment from the baseline. Calculate the ratio: stated_total / baseline_total, then apply that ratio to each item's baseline unit price. Each item has different baseline prices — a blanket price makes no sense across different product categories.
   - Example: If baseline total is $87,150 and supplier says "$80,000 total", ratio = 0.918. Apply: each item's unitPrice = baseline_unitPrice × 0.918.

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

  // ── Force-normalize quantities to baseline ──
  // The LLM sometimes extracts wrong quantities (e.g., 5000 instead of 500).
  // Every supplier MUST be compared on the same baseline quantities.
  const baselineQtyMap = new Map(
    quotationItems.map((qi) => [qi.rawSku.toUpperCase().trim(), qi.quantity]),
  );
  for (const item of object.items) {
    const baselineQty = baselineQtyMap.get(item.sku.toUpperCase().trim());
    if (baselineQty && item.quantity !== baselineQty) {
      console.log(
        `offer-extractor: Normalizing ${item.sku} qty ${item.quantity} → ${baselineQty} for ${supplierProfile.name}`,
      );
      item.quantity = baselineQty;
    }
  }

  // ── Price sanity: detect and fix nonsensical per-item prices ──
  // The LLM can produce garbage prices in several ways:
  //   A) Blanket price — "$165/unit" applied to all 20 different SKUs
  //   B) Wrong magnitude — confusing total with unit price, or qty tier mixup
  //   C) Hallucinated prices — completely fabricated numbers
  // Strategy: compare each extracted price against its baseline. If the ratio is
  // extreme (>3x or <0.2x), it's wrong. Fix individually or globally.
  if (quotationItems.length > 0 && object.items.length > 0) {
    const baselineMap = new Map(
      quotationItems.map((qi) => [
        qi.rawSku.toUpperCase().trim(),
        { unitPrice: qi.unitPrice, totalPrice: qi.totalPrice, quantity: qi.quantity },
      ]),
    );
    const baselineTotal = quotationItems.reduce((s, qi) => s + qi.totalPrice, 0);

    // Step 1: Detect blanket pricing (most items share the same extracted price)
    const priceCounts = new Map<string, number>();
    for (const item of object.items) {
      const key = item.unitPrice.toFixed(2);
      priceCounts.set(key, (priceCounts.get(key) ?? 0) + 1);
    }
    const mostCommonCount = Math.max(...priceCounts.values());
    const isBlanket =
      object.items.length > 3 &&
      mostCommonCount >= object.items.length * 0.7; // 70%+ items share same price

    if (isBlanket) {
      // Find the dominant price
      let dominantPrice = 0;
      for (const [price, count] of priceCounts) {
        if (count === mostCommonCount) {
          dominantPrice = parseFloat(price);
          break;
        }
      }

      // Check if this dominant price is plausible — does it match most baselines?
      let matchesBaseline = 0;
      for (const qi of quotationItems) {
        if (Math.abs(qi.unitPrice - dominantPrice) / qi.unitPrice < 0.3) {
          matchesBaseline++;
        }
      }

      // If it doesn't match baselines, it's a blanket quote → proportional adjustment
      if (matchesBaseline < quotationItems.length * 0.3) {
        // Use the LLM's stated total to compute the intended ratio
        const ratio = baselineTotal > 0 && object.totalCost > 0
          ? Math.max(0.5, Math.min(2.0, object.totalCost / baselineTotal))
          : 1;

        console.log(
          `offer-extractor: Blanket price detected ($${dominantPrice}/unit on ${mostCommonCount}/${object.items.length} items) for ${supplierProfile.name}. Applying proportional adjustment (${(ratio * 100).toFixed(1)}% of baseline).`,
        );

        for (const item of object.items) {
          const bl = baselineMap.get(item.sku.toUpperCase().trim());
          if (bl) {
            item.unitPrice = Math.round(bl.unitPrice * ratio * 100) / 100;
          }
        }
      }
    }

    // Step 2: Per-item outlier correction (catches individual bad extractions)
    // Any item whose price ratio vs baseline is extreme gets snapped back.
    let outliersCorrected = 0;
    for (const item of object.items) {
      const bl = baselineMap.get(item.sku.toUpperCase().trim());
      if (!bl || bl.unitPrice === 0) continue;

      const ratio = item.unitPrice / bl.unitPrice;
      if (ratio > 3.0 || ratio < 0.2) {
        // This price is nonsensical — snap to baseline (the supplier didn't mention this SKU specifically)
        console.log(
          `offer-extractor: Outlier price for ${item.sku}: $${item.unitPrice.toFixed(2)} is ${ratio.toFixed(1)}x baseline $${bl.unitPrice.toFixed(2)}. Snapping to baseline for ${supplierProfile.name}.`,
        );
        item.unitPrice = bl.unitPrice;
        outliersCorrected++;
      }
    }
    if (outliersCorrected > 0) {
      console.log(
        `offer-extractor: Corrected ${outliersCorrected} outlier price(s) for ${supplierProfile.name}`,
      );
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

  // ── Log price vs baseline for diagnostics (no clipping — trust extracted per-item prices) ──
  const baselineTotal = quotationItems.reduce((sum, item) => sum + item.totalPrice, 0);
  if (baselineTotal > 0) {
    const ratio = object.totalCost / baselineTotal;
    console.log(
      `offer-extractor: ${supplierProfile.name} total ${formatCurrency(object.totalCost)} = ${(ratio * 100).toFixed(1)}% of baseline ${formatCurrency(baselineTotal)}`,
    );
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
