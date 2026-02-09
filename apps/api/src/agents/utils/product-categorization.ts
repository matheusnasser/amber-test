/**
 * Product categorization and domain knowledge
 */

import type { QuotationItemData } from "../types";

/**
 * Product category keywords for automatic classification
 * Could be loaded from JSON config in the future
 */
export const PRODUCT_KEYWORDS: Record<string, string[]> = {
  "Insulated Outerwear": [
    "jacket",
    "parka",
    "coat",
    "down",
    "insulated",
    "puffer",
  ],
  "Shell / Rain Gear": [
    "shell",
    "rain",
    "waterproof",
    "windbreaker",
    "gore-tex",
  ],
  "Fleece / Midlayer": ["fleece", "midlayer", "pullover", "quarter-zip"],
  "Pants / Bottoms": ["pants", "shorts", "trousers", "legging"],
  "Base Layers": ["base layer", "thermal", "merino", "underwear"],
  Accessories: ["hat", "gloves", "beanie", "scarf", "gaiter", "sock"],
  "Backpacks / Bags": ["pack", "backpack", "bag", "daypack", "duffel"],
  Footwear: ["boot", "shoe", "sandal", "trail runner"],
};

/**
 * Infer product types/categories from quotation items
 * Returns formatted summary for agent context
 */
export function inferProductTypes(items: QuotationItemData[]): string | null {
  const categories = new Map<string, string[]>();

  for (const item of items) {
    const desc = `${item.rawSku} ${item.rawDescription}`.toLowerCase();
    for (const [category, keywords] of Object.entries(PRODUCT_KEYWORDS)) {
      if (keywords.some((kw) => desc.includes(kw))) {
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category)!.push(item.rawSku);
        break;
      }
    }
  }

  if (categories.size === 0) return null;

  const lines = Array.from(categories.entries()).map(
    ([cat, skus]) =>
      `- ${cat}: ${skus.slice(0, 3).join(", ")}${skus.length > 3 ? ` (+${skus.length - 3} more)` : ""}`,
  );

  return `Product categories in this order:\n${lines.join("\n")}`;
}
