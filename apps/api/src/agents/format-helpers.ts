/**
 * Format a product reference for agent messages.
 * Standard format: sku(description)
 *
 * @param sku - Product SKU code (e.g., "MB013-0BS-XL")
 * @param description - Product description (e.g., "Insulated Winter Jacket")
 * @returns Formatted string: "sku(description)"
 *
 * @example
 * formatSkuRef("MB013-0BS-XL", "Insulated Winter Jacket")
 * // Returns: "MB013-0BS-XL(Insulated Winter Jacket)"
 */
export function formatSkuRef(sku: string, description: string | null | undefined): string {
  const desc = description?.trim() || "Unknown Item";
  return `${sku}(${desc})`;
}

/**
 * Format a list of quotation items for agent messages.
 * Each item formatted as: sku(description) — Qty [quantity]
 *
 * @param items - Array of quotation items
 * @param includePrice - Whether to include unit/total prices (default: false)
 * @returns Formatted multi-line string, one item per line
 *
 * @example
 * formatItemList([{ rawSku: "MB013-0BS-XL", rawDescription: "Jacket", quantity: 50 }])
 * // Returns: "- MB013-0BS-XL(Jacket) — Qty 50"
 */
export function formatItemList(
  items: Array<{ rawSku: string; rawDescription: string; quantity: number; unitPrice?: number; totalPrice?: number }>,
  includePrice = false,
): string {
  return items
    .map((item) => {
      let line = `- ${formatSkuRef(item.rawSku, item.rawDescription)} — Qty ${item.quantity}`;
      if (includePrice && item.unitPrice !== undefined && item.totalPrice !== undefined) {
        line += ` | Unit: $${item.unitPrice.toFixed(2)} | Total: $${item.totalPrice.toFixed(2)}`;
      }
      return line;
    })
    .join("\n");
}
