import { generateObject } from "ai";
import { z } from "zod";
import { reasoningModel } from "../lib/ai";
import type { XlsxSheet, XlsxWorkbook } from "./xlsx-reader";

// Chunk boundary: if a sheet has more than this many data rows, split into chunks
// Each chunk gets the header rows prepended for context
const CHUNK_SIZE = 80;

export interface RawParsedItem {
  rawSku: string;
  rawDescription: string;
  rawQuantity: number | null;
  rawUnitPrice: number | null;
  rawTotalPrice: number | null;
  rawNotes: string | null;
  sheetName: string;
  sheetIndex: number;
}

// ─── Zod schema — single source of truth for LLM structured output ──────────

export interface SheetMetadata {
  supplierName: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  currency: string | null;
  incoterm: string | null;
  validUntil: string | null;
  moq: string | null;
  notes: string | null;
}

const extractionSchema = z.object({
  metadata: z.object({
    supplierName: z.string().nullable().describe("Supplier/vendor/factory name if found in the sheet"),
    paymentTerms: z.string().nullable().describe("Payment terms (e.g., 'Net 30', '50% deposit', 'T/T 30/70')"),
    leadTimeDays: z.number().nullable().describe("Lead time in days if mentioned"),
    currency: z.string().nullable().describe("Currency code (e.g., 'USD', 'EUR', 'CNY')"),
    incoterm: z.string().nullable().describe("Incoterm if mentioned (e.g., 'FOB', 'CIF', 'EXW')"),
    validUntil: z.string().nullable().describe("Quote validity/expiry date if mentioned"),
    moq: z.string().nullable().describe("Minimum order quantity if mentioned as a general policy"),
    notes: z.string().nullable().describe("Any other relevant metadata (shipping info, special conditions, etc.)"),
  }).describe("Sheet-level metadata extracted from headers, footers, or non-product rows"),
  items: z.array(
    z.object({
      rawSku: z.string().describe("Product code, SKU, or item number"),
      rawDescription: z.string().describe("Product name or description"),
      rawQuantity: z.number().nullable().describe("Quantity ordered"),
      rawUnitPrice: z.number().nullable().describe("FINAL unit price AFTER any discounts are applied"),
      rawTotalPrice: z.number().nullable().describe("Total line price (numeric, no currency symbols)"),
      rawNotes: z.string().nullable().describe("Original base price + discount info, or any other notes"),
    }),
  ).describe("Extracted product line items. Return an empty array if no product items found."),
});

type ExtractedItem = Omit<RawParsedItem, "sheetName" | "sheetIndex">;

// ─── Grid Pre-processing ─────────────────────────────────────────────────────
// Only do the bare minimum: remove empty rows/cols to reduce token count.
// DO NOT try to detect headers, discount columns, etc — that's the LLM's job.

function isRowEmpty(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

function isColumnEmpty(grid: string[][], colIdx: number): boolean {
  return grid.every((row) => (row[colIdx] ?? "").trim() === "");
}

function preprocessGrid(grid: string[][]): string[][] {
  if (grid.length === 0) return grid;

  // 1. Remove fully empty columns
  const colCount = Math.max(...grid.map((r) => r.length));
  const nonEmptyCols: number[] = [];
  for (let c = 0; c < colCount; c++) {
    if (!isColumnEmpty(grid, c)) {
      nonEmptyCols.push(c);
    }
  }

  let cleaned = grid.map((row) => nonEmptyCols.map((c) => row[c] ?? ""));

  // 2. Remove trailing empty rows
  while (cleaned.length > 0 && isRowEmpty(cleaned[cleaned.length - 1])) {
    cleaned.pop();
  }

  // 3. Remove consecutive empty rows in the middle (keep max 1)
  const deduped: string[][] = [];
  let lastEmpty = false;
  for (const row of cleaned) {
    const empty = isRowEmpty(row);
    if (empty && lastEmpty) continue;
    deduped.push(row);
    lastEmpty = empty;
  }

  return deduped;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatGridAsTable(grid: string[][]): string {
  return grid
    .map((row, idx) => `R${idx}: | ${row.join(" | ")} |`)
    .join("\n");
}

// ─── The One Prompt ──────────────────────────────────────────────────────────
// A single, comprehensive prompt that handles ANY spreadsheet layout.

function buildPrompt(gridTable: string, sheetName: string, totalSheets: number): string {
  return `You are a world-class data extraction specialist. Your job: extract every product line item AND any useful metadata from this raw spreadsheet grid.

<sheet_info>
Sheet: "${sheetName}" (${totalSheets} sheet(s) in workbook)
</sheet_info>

<raw_grid>
${gridTable}
</raw_grid>

<instructions>
STEP 1 — UNDERSTAND THE LAYOUT
Before extracting, figure out:
- Where are the headers? (could be row 0, row 5, or buried anywhere)
- What does each column represent? Match columns to: SKU/Code, Description, Quantity, Unit Price, Total Price, Discount %, Notes, etc.
- Are there quantity tiers encoded in COLUMN HEADERS? (e.g., "Price @ 1000 pcs", "Qty 5000", "MOQ 500")
- Is there a Discount/Markup column that modifies the base price?

STEP 2 — EXTRACT METADATA
Scan header rows, footer rows, and non-product rows for business-relevant metadata:
- Supplier/vendor/factory name
- Payment terms (e.g., "Net 30", "50% deposit + 50% before shipping", "T/T 30/70")
- Lead time in days (e.g., "45 days after order confirmation")
- Currency (USD, EUR, CNY, etc.)
- Incoterm (FOB, CIF, EXW, etc.)
- Quote validity/expiry date
- MOQ (minimum order quantity) as a general policy
- Any other relevant conditions, shipping info, special notes
Set fields to null if not found. Do NOT invent metadata.

STEP 3 — EXTRACT ITEMS
For each product row, extract:
- rawSku: Product code/SKU/style number (alphanumeric identifiers like "OPP027-FNV-28-30", "MB002-LGR-S", "12345"). If no SKU column exists, use the row number as "ROW_1", "ROW_2", etc.
- rawDescription: Product name/description. May be in same cell as SKU.
- rawQuantity: Order quantity. If quantities are in column HEADERS (tier-based pricing), parse from header text.
- rawUnitPrice: Price per unit — see DISCOUNT rules below.
- rawTotalPrice: Line total. Calculate qty × unitPrice if missing.
- rawNotes: Any extra info. MUST include original base price + discount % if a discount was applied.

STEP 4 — HANDLE DISCOUNTS (CRITICAL)
If you see a "Discount (%)", "Disc", "Markup", or similar column:
- The price column (e.g., "FOB Price", "Unit Price") shows the BASE price BEFORE discount.
- You MUST compute the FINAL price: rawUnitPrice = basePrice × (1 − discount/100)
- Example: FOB $45.00, Discount 5% → rawUnitPrice = 45 × 0.95 = 42.75
- If total column already reflects the discount, use it directly.
- Store original info in rawNotes: "FOB $45.00, 5% disc"

STEP 5 — HANDLE QUANTITY TIERS
If the spreadsheet has multiple price columns per row for different quantities:
- Create SEPARATE items for each quantity tier with the SAME SKU.
- Example: SKU "ABC-123" with "Qty 1000: $50" and "Qty 5000: $45" → TWO items.

RULES:
1. Extract ONLY product line items in "items". Skip headers, subtotals, totals, blank rows — those go into "metadata" if relevant.
2. Strip currency symbols and commas from prices: "$1,234.56" → 1234.56
3. If unit price exists but total is missing: rawTotalPrice = rawUnitPrice × rawQuantity
4. If total exists but unit price is missing: rawUnitPrice = rawTotalPrice / rawQuantity
5. If the sheet has NO product data (cover page, T&C, shipping info), return empty items array but still extract metadata.
6. Do NOT invent data. Missing fields = null.
7. rawUnitPrice MUST be the FINAL price after any discounts. Never return the pre-discount base price.
</instructions>`;
}

// ─── LLM extraction (single call per grid) ───────────────────────────────────

interface ExtractionResult {
  items: ExtractedItem[];
  metadata: SheetMetadata;
}

const EMPTY_METADATA: SheetMetadata = {
  supplierName: null, paymentTerms: null, leadTimeDays: null,
  currency: null, incoterm: null, validUntil: null, moq: null, notes: null,
};

async function extractGrid(
  grid: string[][],
  sheetName: string,
  totalSheets: number,
  label: string,
): Promise<ExtractionResult> {
  const gridTable = formatGridAsTable(grid);
  const prompt = buildPrompt(gridTable, sheetName, totalSheets);

  // Dynamic maxTokens based on grid size
  const estimatedItems = Math.min(Math.max(grid.length, 10), 300);
  const maxTokens = Math.min(estimatedItems * 150 + 800, 8192);

  // Use Sonnet directly — Haiku frequently fails on the metadata+items schema
  const startTime = Date.now();
  try {
    const { object } = await generateObject({
      model: reasoningModel,
      schema: extractionSchema,
      prompt,
      temperature: 0,
      maxTokens: Math.max(maxTokens, 8000),
    });

    const elapsed = Date.now() - startTime;
    const meta = object.metadata;
    const metaHits = Object.values(meta).filter(Boolean).length;
    console.log(`llm-structurer: [${label}] Sonnet extracted ${object.items.length} items + ${metaHits} metadata fields in ${elapsed}ms`);
    return { items: object.items, metadata: meta };
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`llm-structurer: [${label}] Sonnet failed in ${elapsed}ms:`, error);
    return { items: [], metadata: EMPTY_METADATA };
  }
}

// ─── Sheet processing ────────────────────────────────────────────────────────

interface SheetResult {
  items: ExtractedItem[];
  metadata: SheetMetadata;
}

async function structureSheet(sheet: XlsxSheet, totalSheets: number): Promise<SheetResult> {
  const { grid: rawGrid, sheetName } = sheet;
  const totalStartTime = Date.now();
  console.log(
    `llm-structurer: [${sheetName}] Starting — ${rawGrid.length} rows`,
  );

  // Minimal preprocessing: strip empty rows/cols
  const grid = preprocessGrid(rawGrid);
  if (grid.length === 0) {
    console.log(`llm-structurer: [${sheetName}] Empty after preprocessing — skipping`);
    return { items: [], metadata: EMPTY_METADATA };
  }

  if (grid.length !== rawGrid.length) {
    console.log(
      `llm-structurer: [${sheetName}] Cleaned: ${rawGrid.length} → ${grid.length} rows`,
    );
  }

  // Small sheet (≤ CHUNK_SIZE rows) — single LLM call
  if (grid.length <= CHUNK_SIZE) {
    const result = await extractGrid(grid, sheetName, totalSheets, `${sheetName} (${grid.length}r)`);
    const elapsed = Date.now() - totalStartTime;
    console.log(`llm-structurer: [${sheetName}] Done in ${elapsed}ms — ${result.items.length} items`);
    return result;
  }

  // Large sheet — chunk it, prepending first few rows (likely headers) to each chunk
  let headerEndRow = 0;
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const numericCells = grid[r].filter((cell) => /^\s*\$?\s*[\d,]+\.?\d*\s*$/.test(cell.trim())).length;
    if (numericCells >= 2) {
      headerEndRow = r;
      break;
    }
    headerEndRow = r + 1;
  }
  headerEndRow = Math.min(headerEndRow, 10);

  const headerRows = grid.slice(0, headerEndRow);
  console.log(
    `llm-structurer: [${sheetName}] Large sheet (${grid.length}r) — chunking with ${headerEndRow} header row(s)`,
  );

  const allItems: ExtractedItem[] = [];
  let mergedMetadata: SheetMetadata = { ...EMPTY_METADATA };
  let chunkIdx = 0;

  for (let i = headerEndRow; i < grid.length; i += CHUNK_SIZE) {
    const endRow = Math.min(i + CHUNK_SIZE, grid.length);
    const chunk = [...headerRows, ...grid.slice(i, endRow)];
    chunkIdx++;
    const label = `${sheetName} chunk ${chunkIdx} (rows ${i}-${endRow})`;

    const result = await extractGrid(chunk, sheetName, totalSheets, label);
    allItems.push(...result.items);
    // Merge metadata: first non-null value wins
    for (const key of Object.keys(EMPTY_METADATA) as (keyof SheetMetadata)[]) {
      if (mergedMetadata[key] === null && result.metadata[key] !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (mergedMetadata as any)[key] = result.metadata[key];
      }
    }
  }

  // Deduplicate: same SKU + same qty + same price = duplicate
  const seen = new Set<string>();
  const deduplicated = allItems.filter((item) => {
    const key = `${item.rawSku}::${item.rawQuantity}::${item.rawUnitPrice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const elapsed = Date.now() - totalStartTime;
  console.log(
    `llm-structurer: [${sheetName}] Done in ${elapsed}ms — ${deduplicated.length} items (${allItems.length - deduplicated.length} dupes removed)`,
  );

  return { items: deduplicated, metadata: mergedMetadata };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface StructureResult {
  items: RawParsedItem[];
  sheetMetadata: Map<string, SheetMetadata>; // sheetName → metadata
}

export async function structureWithLlm(
  workbook: XlsxWorkbook,
): Promise<StructureResult> {
  const totalStartTime = Date.now();
  console.log(
    `llm-structurer: Processing workbook — ${workbook.sheets.length} sheet(s)`,
  );

  // Process all sheets in parallel
  const sheetResults = await Promise.all(
    workbook.sheets.map((sheet) => structureSheet(sheet, workbook.sheets.length)),
  );

  // Tag items with sheet metadata and flatten
  const allItems: RawParsedItem[] = [];
  const sheetMetadata = new Map<string, SheetMetadata>();

  for (let i = 0; i < workbook.sheets.length; i++) {
    const sheet = workbook.sheets[i];
    const result = sheetResults[i];

    for (const item of result.items) {
      allItems.push({
        ...item,
        sheetName: sheet.sheetName,
        sheetIndex: sheet.sheetIndex,
      });
    }

    // Store metadata per sheet
    sheetMetadata.set(sheet.sheetName, result.metadata);

    // Log any metadata found
    const meta = result.metadata;
    const metaParts: string[] = [];
    if (meta.supplierName) metaParts.push(`supplier: ${meta.supplierName}`);
    if (meta.paymentTerms) metaParts.push(`terms: ${meta.paymentTerms}`);
    if (meta.leadTimeDays) metaParts.push(`lead: ${meta.leadTimeDays}d`);
    if (meta.currency) metaParts.push(`currency: ${meta.currency}`);
    if (meta.incoterm) metaParts.push(`incoterm: ${meta.incoterm}`);
    if (meta.validUntil) metaParts.push(`valid: ${meta.validUntil}`);
    if (meta.moq) metaParts.push(`MOQ: ${meta.moq}`);
    if (meta.notes) metaParts.push(`notes: ${meta.notes.slice(0, 80)}`);
    if (metaParts.length > 0) {
      console.log(`llm-structurer: [${sheet.sheetName}] Metadata: ${metaParts.join(" | ")}`);
    }
  }

  const elapsed = Date.now() - totalStartTime;
  console.log(
    `llm-structurer: Total: ${allItems.length} items from ${workbook.sheets.length} sheet(s) in ${elapsed}ms`,
  );

  if (allItems.length === 0) {
    console.warn("llm-structurer: WARNING — No items extracted. The spreadsheet format may be unsupported.");
  }

  // Post-extraction sanity: catch any unapplied discounts the LLM missed
  fixUnappliedDiscounts(allItems);

  return { items: allItems, sheetMetadata };
}

// ─── Post-extraction discount sanity check ───────────────────────────────────
// Safety net: if the LLM still missed discounts, we detect and fix them here.

function fixUnappliedDiscounts(items: RawParsedItem[]): void {
  // Group by SKU
  const skuMap = new Map<string, RawParsedItem[]>();
  for (const item of items) {
    const key = item.rawSku.toUpperCase().trim();
    if (!skuMap.has(key)) skuMap.set(key, []);
    skuMap.get(key)!.push(item);
  }

  let fixCount = 0;

  // Layer 1: Multi-tier check — same unit price at different quantities is suspicious
  for (const [sku, tiers] of skuMap) {
    if (tiers.length < 2) continue;

    const unitPrices = tiers.map((t) => t.rawUnitPrice).filter((p) => p !== null && p > 0) as number[];
    const quantities = tiers.map((t) => t.rawQuantity).filter((q) => q !== null && q > 0) as number[];

    if (unitPrices.length < 2 || quantities.length < 2) continue;

    const allSameUnit = unitPrices.every((p) => Math.abs(p - unitPrices[0]) < 0.01);
    const allDiffQty = new Set(quantities).size > 1;

    if (allSameUnit && allDiffQty) {
      let fixed = 0;
      for (const tier of tiers) {
        if (
          tier.rawTotalPrice !== null &&
          tier.rawTotalPrice > 0 &&
          tier.rawQuantity !== null &&
          tier.rawQuantity > 0
        ) {
          const derivedUnit = Math.round((tier.rawTotalPrice / tier.rawQuantity) * 100) / 100;
          if (Math.abs(derivedUnit - (tier.rawUnitPrice ?? 0)) >= 0.01) {
            const oldPrice = tier.rawUnitPrice;
            tier.rawUnitPrice = derivedUnit;
            tier.rawNotes = `${tier.rawNotes ? tier.rawNotes + "; " : ""}Base FOB $${oldPrice}, adjusted from total`;
            fixed++;
          }
        }
      }
      if (fixed > 0) {
        fixCount += fixed;
        console.log(
          `llm-structurer: [discount-fix] ${sku} — ${fixed} tier(s) had identical unit prices at different qtys, derived from total`,
        );
      }
    }
  }

  // Layer 2: Individual item check — if qty × unitPrice >> totalPrice, discount wasn't applied
  for (const item of items) {
    if (
      item.rawQuantity !== null &&
      item.rawQuantity > 0 &&
      item.rawUnitPrice !== null &&
      item.rawUnitPrice > 0 &&
      item.rawTotalPrice !== null &&
      item.rawTotalPrice > 0
    ) {
      const computed = item.rawQuantity * item.rawUnitPrice;
      const diff = Math.abs(computed - item.rawTotalPrice);
      if (diff > computed * 0.005 && item.rawTotalPrice < computed) {
        const derivedUnit = Math.round((item.rawTotalPrice / item.rawQuantity) * 100) / 100;
        const discountPct = Math.round((1 - item.rawTotalPrice / computed) * 10000) / 100;
        const oldPrice = item.rawUnitPrice;
        item.rawUnitPrice = derivedUnit;
        item.rawNotes = `${item.rawNotes ? item.rawNotes + "; " : ""}Base FOB $${oldPrice}, ${discountPct}% disc applied`;
        fixCount++;
        console.log(
          `llm-structurer: [discount-fix] ${item.rawSku} — unit $${oldPrice} → $${derivedUnit} (${discountPct}% disc)`,
        );
      }
    }
  }

  if (fixCount > 0) {
    console.log(`llm-structurer: [discount-fix] Fixed ${fixCount} item(s)`);
  }
}
