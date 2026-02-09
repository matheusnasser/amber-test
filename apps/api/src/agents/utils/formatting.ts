/**
 * Shared formatting utilities for agent messages and prompts
 */

import { formatSkuRef } from "../format-helpers";
import type { MessageData, QuotationItemData, SupplierProfile } from "../types";

/**
 * Format currency with smart abbreviation
 * - Values >= $1000 show as "$5.2K"
 * - Values < $1000 show as "$42.50"
 */
export function formatCurrency(value: number): string {
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}K`;
  }
  return `$${value.toFixed(2)}`;
}

/**
 * Format currency with full precision (no abbreviation)
 */
export function formatCurrencyFull(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format baseline quotation items with pricing tiers
 */
export function formatBaselineItems(
  items: QuotationItemData[],
  hideBasePrices = false,
): string {
  const lines: string[] = [];
  for (const item of items) {
    if (hideBasePrices) {
      lines.push(
        `  ${formatSkuRef(item.rawSku, item.rawDescription)} — Qty ${item.quantity}`,
      );
    } else {
      lines.push(
        `  ${formatSkuRef(item.rawSku, item.rawDescription)}: Qty ${item.quantity}, baseline unit price $${item.unitPrice.toFixed(2)}`,
      );
      if (item.tiers && item.tiers.length > 1) {
        for (const tier of item.tiers) {
          if (tier.quantity === item.quantity) continue;
          lines.push(
            `    ↳ Volume pricing: Qty ${tier.quantity.toLocaleString()} @ $${tier.unitPrice.toFixed(2)}/unit`,
          );
        }
      }
    }
  }
  return lines.join("\n");
}

/**
 * Format quotation table with tiers and totals
 */
export function formatQuotationTable(items: QuotationItemData[]): string {
  const lines: string[] = [];
  const hasAnyTiers = items.some((i) => i.tiers && i.tiers.length > 1);

  for (const item of items) {
    let line = `  - ${formatSkuRef(item.rawSku, item.rawDescription)} | Qty: ${item.quantity} | Unit: $${item.unitPrice.toFixed(2)} | Total: $${item.totalPrice.toFixed(2)}`;
    if (item.rawNotes) {
      line += ` | Notes: "${item.rawNotes}"`;
    }
    lines.push(line);
    if (item.tiers && item.tiers.length > 1) {
      for (const tier of item.tiers) {
        if (tier.quantity === item.quantity) continue;
        lines.push(
          `      ↳ Volume tier: Qty ${tier.quantity.toLocaleString()} → $${tier.unitPrice.toFixed(2)}/unit ($${tier.totalPrice.toFixed(2)} total)`,
        );
      }
    }
  }

  const totalCost = items.reduce((sum, item) => sum + item.totalPrice, 0);
  lines.push(
    `  BASELINE TOTAL: $${totalCost.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
  );

  if (hasAnyTiers) {
    const tierTotals = new Map<number, number>();
    for (const item of items) {
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
    const tierSummary = Array.from(tierTotals.entries())
      .sort(([a], [b]) => a - b)
      .map(
        ([qty, total]) =>
          `Qty ${qty.toLocaleString()}: $${total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      )
      .join(" | ");
    lines.push(`  TIER TOTALS: ${tierSummary}`);
    lines.push(
      `  NOTE: Multiple pricing tiers detected. Consider whether order quantities should be adjusted or split across tiers to optimize cost.`,
    );
  }

  return lines.join("\n");
}

/**
 * Format supplier profile summary
 */
export function formatSupplierProfile(profile: SupplierProfile): string {
  return [
    `Supplier: ${profile.name} (${profile.code})`,
    `  [INTERNAL] Quality Rating: ${profile.qualityRating}/5`,
    `  Price Level: ${profile.priceLevel}`,
    `  Lead Time: ${profile.leadTimeDays} days`,
    `  Payment Terms: ${profile.paymentTerms}`,
  ].join("\n");
}

/**
 * Format conversation history for agent context
 */
export function formatConversationHistory(messages: MessageData[]): string {
  if (messages.length === 0) return "(No prior conversation.)";
  return messages
    .map((m) => {
      const speaker = m.role === "brand_agent" ? "You (Alex)" : "Supplier";
      return `${speaker}: ${m.content}`;
    })
    .join("\n\n");
}
