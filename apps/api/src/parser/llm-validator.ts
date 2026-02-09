import { generateObject } from "ai";
import { z } from "zod";
import { validatorModel } from "../lib/ai";
import type { RawParsedItem } from "./llm-structurer";
import type { XlsxWorkbook } from "./xlsx-reader";

export interface ValidationFlag {
  itemIndex: number;
  field: string;
  extracted: string | number | null;
  actual: string;
  issue: string;
}

const validationSchema = z.object({
  flags: z.array(
    z.object({
      itemIndex: z.number().describe("Index of the item in the extracted list"),
      field: z.string().describe("Which field has the issue (e.g. rawUnitPrice, rawQuantity)"),
      extracted: z.union([z.string(), z.number(), z.null()]).describe("The value that was extracted"),
      actual: z.string().describe("What the value should be based on the grid"),
      issue: z.string().describe("Brief description of the discrepancy"),
    }),
  ),
});

function formatGridCompact(grid: string[][]): string {
  return grid.map((row, idx) => `R${idx}: ${row.join(" | ")}`).join("\n");
}

function formatItemsForValidation(items: RawParsedItem[]): string {
  return items
    .map(
      (item, idx) =>
        `[${idx}] SKU: ${item.rawSku} | Desc: ${item.rawDescription} | Qty: ${item.rawQuantity} | Unit: ${item.rawUnitPrice} | Total: ${item.rawTotalPrice}`,
    )
    .join("\n");
}

async function validateSheet(
  grid: string[][],
  sheetName: string,
  items: RawParsedItem[],
  globalOffset: number,
): Promise<ValidationFlag[]> {
  if (items.length === 0) return [];

  const startTime = Date.now();
  console.log(
    `llm-validator: [${sheetName}] Validating ${items.length} items...`,
  );

  const gridText = formatGridCompact(grid);
  const itemsText = formatItemsForValidation(items);

  try {
    const { object } = await generateObject({
      model: validatorModel,
      schema: validationSchema,
      prompt: `<role>You are a data validation specialist. Compare extracted items against the raw spreadsheet grid to catch extraction errors.</role>

<raw_spreadsheet_grid>
${gridText}
</raw_spreadsheet_grid>

<extracted_items>
${itemsText}
</extracted_items>

<instructions>
For each extracted item, verify against the raw grid:
1. Does the unit price match what appears in the grid?
2. Does the total price match?
3. Does the quantity match?
4. Is the SKU correctly read?

If everything looks correct, return an empty flags array.

Common issues to check:
- Decimal errors (e.g., $850 vs $8.50)
- Transposed digits (e.g., 530 vs 350)
- Missing decimal points
- Wrong column mapped to wrong field

Do NOT flag minor rounding differences (e.g., 23988 vs 23987.99). Only flag discrepancies greater than $1 or 1 unit that indicate a real extraction error.
</instructions>`,
      temperature: 0,
    });

    const elapsed = Date.now() - startTime;

    // Remap itemIndex to global offset and filter out trivial rounding differences
    const remapped: ValidationFlag[] = object.flags
      .map((flag) => ({
        ...flag,
        itemIndex: flag.itemIndex + globalOffset,
      }))
      .filter((flag) => {
        if (flag.extracted == null || flag.actual == null) return true;
        const extracted = typeof flag.extracted === "string" ? parseFloat(flag.extracted) : flag.extracted;
        const actual = parseFloat(flag.actual);
        if (isNaN(extracted) || isNaN(actual)) return true;
        // Drop flags where the difference is less than $1 (floating point noise)
        return Math.abs(extracted - actual) >= 1;
      });

    console.log(
      `llm-validator: [${sheetName}] ${remapped.length} flags in ${elapsed}ms`,
    );
    for (const flag of remapped) {
      console.log(
        `  - Item ${flag.itemIndex}: ${flag.field} — ${flag.issue}`,
      );
    }

    return remapped;
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(
      `llm-validator: [${sheetName}] Failed after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(
      `llm-validator: [${sheetName}] Returning empty flags (non-critical)`,
    );
    return [];
  }
}

// ─── Deterministic arithmetic validation (no LLM needed) ────────────────────

function validateArithmetic(items: RawParsedItem[]): ValidationFlag[] {
  const flags: ValidationFlag[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const qty = item.rawQuantity;
    const unit = item.rawUnitPrice;
    const total = item.rawTotalPrice;

    // If we have qty + unitPrice, we can compute the expected total
    if (qty !== null && qty > 0 && unit !== null && unit > 0) {
      const computed = Math.round(qty * unit * 100) / 100;

      if (total !== null && total > 0) {
        // Cross-validate: extracted total vs computed total
        const diff = Math.abs(total - computed);
        if (diff >= 1) {
          flags.push({
            itemIndex: i,
            field: "rawTotalPrice",
            extracted: total,
            actual: String(computed),
            issue: `Total price mismatch: extracted $${total.toFixed(2)} but qty(${qty}) × unit($${unit.toFixed(2)}) = $${computed.toFixed(2)}`,
          });
          // Override with calculated value
          item.rawTotalPrice = computed;
          console.log(
            `  validator-arith: [${i}] ${item.rawSku} — overriding total $${total.toFixed(2)} → $${computed.toFixed(2)}`,
          );
        }
      } else {
        // Total missing — fill it in
        item.rawTotalPrice = computed;
        console.log(
          `  validator-arith: [${i}] ${item.rawSku} — computed missing total: $${computed.toFixed(2)}`,
        );
      }
    } else if (total !== null && total > 0 && qty !== null && qty > 0 && (unit === null || unit === 0)) {
      // Total + qty present but no unit price — derive it
      const derived = Math.round((total / qty) * 100) / 100;
      item.rawUnitPrice = derived;
      console.log(
        `  validator-arith: [${i}] ${item.rawSku} — derived missing unitPrice: $${derived.toFixed(2)} from total/qty`,
      );
    } else if (total !== null && total > 0 && unit !== null && unit > 0 && (qty === null || qty === 0)) {
      // Total + unit present but no qty — derive it
      const derived = Math.round(total / unit);
      item.rawQuantity = derived;
      console.log(
        `  validator-arith: [${i}] ${item.rawSku} — derived missing quantity: ${derived} from total/unit`,
      );
    }
  }

  return flags;
}

export async function validateExtraction(
  workbook: XlsxWorkbook,
  items: RawParsedItem[],
): Promise<ValidationFlag[]> {
  if (items.length === 0) {
    console.log("llm-validator: No items to validate, skipping");
    return [];
  }

  const startTime = Date.now();
  console.log(
    `llm-validator: Validating ${items.length} items across ${workbook.sheets.length} sheet(s)...`,
  );

  // 1. Deterministic arithmetic validation — always runs, mutates items in place
  console.log("llm-validator: Running arithmetic cross-validation...");
  const arithmeticFlags = validateArithmetic(items);
  if (arithmeticFlags.length > 0) {
    console.log(
      `llm-validator: ${arithmeticFlags.length} arithmetic discrepancies found and corrected`,
    );
  }

  // 2. LLM-based validation — cross-checks against raw grid
  const sheetPromises = workbook.sheets.map((sheet) => {
    const sheetItems = items.filter((item) => item.sheetIndex === sheet.sheetIndex);
    if (sheetItems.length === 0) return Promise.resolve([]);

    const globalOffset = items.indexOf(sheetItems[0]);
    return validateSheet(sheet.grid, sheet.sheetName, sheetItems, globalOffset);
  });

  const results = await Promise.all(sheetPromises);
  const llmFlags = results.flat();

  const allFlags = [...arithmeticFlags, ...llmFlags];

  const elapsed = Date.now() - startTime;
  console.log(
    `llm-validator: All validation done in ${elapsed}ms — ${arithmeticFlags.length} arithmetic + ${llmFlags.length} LLM = ${allFlags.length} total flags`,
  );

  return allFlags;
}
