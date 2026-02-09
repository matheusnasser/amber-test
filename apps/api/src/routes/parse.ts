import { Router } from "express";
import multer from "multer";
import { generateObject } from "ai";
import { z } from "zod";
import { prisma } from "@supplier-negotiation/database";
import { structurerModel } from "../lib/ai";
import { readXlsx } from "../parser/xlsx-reader";
import { structureWithLlm } from "../parser/llm-structurer";
import { validateExtraction } from "../parser/llm-validator";
import type { ValidationFlag } from "../parser/llm-validator";
import { matchProducts } from "../matcher/product-matcher";
import type { MatchResult, CandidateProduct } from "../matcher/product-matcher";
import type { RawParsedItem, SheetMetadata } from "../parser/llm-structurer";
import type { XlsxWorkbook } from "../parser/xlsx-reader";

const upload = multer({ storage: multer.memoryStorage() });

export const parseRouter = Router();

// ─── Supplier Name Extraction ──────────────────────────────────────────────

const supplierNameSchema = z.object({
  supplierName: z
    .string()
    .nullable()
    .describe("The supplier or company name found in the spreadsheet header, or null if not identifiable"),
});

async function extractSupplierName(workbook: XlsxWorkbook): Promise<string | null> {
  const sheet = workbook.sheets[0];
  if (!sheet) return null;

  // Take the first 15 rows — supplier name is typically in the header area
  const headerRows = sheet.grid.slice(0, 15);
  if (headerRows.length === 0) return null;

  const gridText = headerRows
    .map((row, idx) => `Row ${idx}: ${row.join(" | ")}`)
    .join("\n");

  try {
    const startTime = Date.now();
    console.log("parse: Extracting supplier name from XLSX header...");

    const { object: result } = await generateObject({
      model: structurerModel,
      schema: supplierNameSchema,
      prompt: `<role>You are a document analysis specialist. Identify the supplier or company name from a quotation spreadsheet header.</role>

<header_rows>
${gridText}
</header_rows>

<metadata>
Sheet name: "${sheet.sheetName}"
</metadata>

<instructions>
Identify the supplier or company name that issued this quotation.

Look for:
- Company names in prominent positions (first rows, bold text, letterheads)
- Text near "From:", "Supplier:", "Company:", "Quotation from", etc.
- Do NOT return the buyer/recipient name — return only the supplier who created this quotation.
- If the spreadsheet is from a generic template with no clear supplier name, return null.
</instructions>`,
      temperature: 0,
    });

    const elapsed = Date.now() - startTime;
    console.log(
      `parse: Supplier name extraction in ${elapsed}ms — ${result.supplierName ?? "not found"}`,
    );

    return result.supplierName;
  } catch (error) {
    console.warn("parse: Supplier name extraction failed, continuing without it:", error);
    return null;
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface PricingTier {
  sheetName: string;
  sheetIndex: number;
  rawQuantity: number | null;
  rawUnitPrice: number | null;
  rawTotalPrice: number | null;
  rawNotes: string | null;
  validationFlags: ValidationFlag[];
}

interface GroupedProduct {
  rawSku: string;
  rawDescription: string;
  productId: string | null;
  matchedSku: string | null;
  productName: string | null;
  matchConfidence: number;
  matchMethod: string;
  hasFlaggedIssues: boolean;
  tiers: PricingTier[];
  candidates: CandidateProduct[];
}

function groupBySku(
  items: RawParsedItem[],
  matches: MatchResult[],
  validationFlags: ValidationFlag[],
): GroupedProduct[] {
  const groups = new Map<string, GroupedProduct>();

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const match = matches[idx];
    const flags = validationFlags.filter((f) => f.itemIndex === idx);

    const groupKey = match.matchedSku?.toUpperCase() ?? item.rawSku.toUpperCase();

    const tier: PricingTier = {
      sheetName: item.sheetName,
      sheetIndex: item.sheetIndex,
      rawQuantity: item.rawQuantity,
      rawUnitPrice: item.rawUnitPrice,
      rawTotalPrice: item.rawTotalPrice,
      rawNotes: item.rawNotes,
      validationFlags: flags,
    };

    const existing = groups.get(groupKey);
    if (existing) {
      existing.tiers.push(tier);
      if (match.confidence > existing.matchConfidence) {
        existing.matchConfidence = match.confidence;
        existing.matchMethod = match.method;
        existing.productId = match.productId;
        existing.matchedSku = match.matchedSku;
        existing.productName = match.productName;
      }
      if (flags.length > 0) {
        existing.hasFlaggedIssues = true;
      }
    } else {
      groups.set(groupKey, {
        rawSku: item.rawSku,
        rawDescription: item.rawDescription,
        productId: match.productId,
        matchedSku: match.matchedSku,
        productName: match.productName,
        matchConfidence: match.confidence,
        matchMethod: match.method,
        hasFlaggedIssues: flags.length > 0,
        tiers: [tier],
        candidates: match.candidates,
      });
    }
  }

  return Array.from(groups.values());
}

// ─── Supplier Profile shape returned to frontend ─────────────────────────────

interface SupplierProfileData {
  id: string;
  code: string;
  name: string;
  qualityRating: number;
  priceLevel: string;
  leadTimeDays: number;
  paymentTerms: string;
  isSimulated: boolean;
}

function toSupplierProfile(s: {
  id: string;
  code: string;
  name: string;
  qualityRating: number;
  priceLevel: string;
  leadTimeDays: number;
  paymentTerms: string;
  isSimulated: boolean;
}): SupplierProfileData {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    qualityRating: s.qualityRating,
    priceLevel: s.priceLevel,
    leadTimeDays: s.leadTimeDays,
    paymentTerms: s.paymentTerms,
    isSimulated: s.isSimulated,
  };
}

type SupplierMatchResult =
  | { matched: true; supplier: SupplierProfileData }
  | { matched: false; extractedName: string | null };

async function getOrg(): Promise<string> {
  const org = await prisma.organization.findFirst();
  if (!org) throw new Error("No organization found. Run db:seed first.");
  return org.id;
}

async function matchSupplier(
  organizationId: string,
  extractedName: string | null,
): Promise<{ supplierMatch: SupplierMatchResult; allSuppliers: SupplierProfileData[]; fallbackSupplierId: string }> {
  const suppliers = await prisma.supplier.findMany({
    where: { organizationId },
    orderBy: { code: "asc" },
  });

  if (suppliers.length === 0) {
    throw new Error("No suppliers found. Run db:seed first.");
  }

  const allSuppliers = suppliers.map(toSupplierProfile);

  // Use first non-simulated supplier as fallback, or first supplier if all are simulated
  const realSuppliers = suppliers.filter((s) => !s.isSimulated);
  const fallbackSupplierId = realSuppliers.length > 0 ? realSuppliers[0].id : suppliers[0].id;

  if (!extractedName) {
    return {
      supplierMatch: { matched: false, extractedName: null },
      allSuppliers,
      fallbackSupplierId,
    };
  }

  const normalized = extractedName.toLowerCase().trim();

  // Case-insensitive substring matching - ONLY against real suppliers, not simulated ones
  const match = realSuppliers.find((s) => {
    const sName = s.name.toLowerCase().trim();
    return sName.includes(normalized) || normalized.includes(sName);
  });

  if (match) {
    return {
      supplierMatch: { matched: true, supplier: toSupplierProfile(match) },
      allSuppliers,
      fallbackSupplierId: match.id,
    };
  }

  return {
    supplierMatch: { matched: false, extractedName },
    allSuppliers,
    fallbackSupplierId,
  };
}

// GET /api/parse/:quotationId — Load stored parse result from DB
parseRouter.get("/:quotationId", async (req, res) => {
  const { quotationId } = req.params;

  try {
    const quotation = await prisma.quotation.findUnique({
      where: { id: quotationId },
      include: {
        supplier: true,
        items: {
          include: {
            product: {
              select: { id: true, sku: true, name: true, color: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!quotation) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }

    // Reconstruct grouped products from stored items
    const groups = new Map<string, GroupedProduct>();

    for (const item of quotation.items) {
      const groupKey = item.rawSku.toUpperCase().trim();
      const tier: PricingTier = {
        sheetName: "",
        sheetIndex: 0,
        rawQuantity: item.quantity,
        rawUnitPrice: item.unitPrice,
        rawTotalPrice: item.totalPrice,
        rawNotes: item.rawNotes,
        validationFlags: [],
      };

      const existing = groups.get(groupKey);
      if (existing) {
        existing.tiers.push(tier);
        if (item.matchConfidence > existing.matchConfidence) {
          existing.matchConfidence = item.matchConfidence;
          existing.matchMethod = item.matchMethod ?? "unmatched";
          existing.productId = item.productId;
          existing.matchedSku = item.product?.sku ?? null;
          existing.productName = item.product?.name ?? null;
        }
      } else {
        // Build candidate list from the matched product (if any)
        const candidates: CandidateProduct[] = [];
        if (item.product) {
          candidates.push({
            productId: item.product.id,
            sku: item.product.sku,
            name: item.product.name,
            color: item.product.color,
            confidence: item.matchConfidence,
          });
        }

        groups.set(groupKey, {
          rawSku: item.rawSku,
          rawDescription: item.rawDescription,
          productId: item.productId,
          matchedSku: item.product?.sku ?? null,
          productName: item.product?.name ?? null,
          matchConfidence: item.matchConfidence,
          matchMethod: item.matchMethod ?? "unmatched",
          hasFlaggedIssues: false,
          tiers: [tier],
          candidates,
        });
      }
    }

    const products = Array.from(groups.values());

    // Match summary
    const autoAccepted = products.filter((p) => p.matchConfidence >= 0.85).length;
    const needsReview = products.filter((p) => p.matchConfidence >= 0.5 && p.matchConfidence < 0.85).length;
    const needsAction = products.filter((p) => p.matchConfidence > 0 && p.matchConfidence < 0.5).length;
    const unmatched = products.filter((p) => p.matchConfidence === 0).length;

    // Supplier match
    const supplierMatch = quotation.supplier
      ? { matched: true as const, supplier: quotation.supplier }
      : { matched: false as const, extractedName: null };

    // All suppliers for selection
    const allSuppliers = await prisma.supplier.findMany({
      where: { organizationId: quotation.organizationId },
      orderBy: { code: "asc" },
    });

    // rawData is stored as an object with sheets and sheetMetadata
    const rawData = quotation.rawData as { sheets?: any[]; sheetMetadata?: Record<string, any> } | null;
    const sheets = rawData?.sheets ?? [];
    const sheetMetadata = rawData?.sheetMetadata ?? {};

    res.json({
      quotationId: quotation.id,
      supplierName: quotation.supplier?.name ?? "",
      supplierCode: quotation.supplier?.code ?? "",
      supplierMatch,
      allSuppliers: allSuppliers.map(toSupplierProfile),
      products,
      matchSummary: {
        totalProducts: products.length,
        totalRawRows: quotation.items.length,
        autoAccepted,
        needsReview,
        needsAction,
        unmatched,
      },
      sheets,
      notes: quotation.notes ?? null,
      sheetMetadata: Object.keys(sheetMetadata).length > 0 ? sheetMetadata : undefined,
    });
  } catch (error) {
    console.error("parse GET: Error loading quotation:", error);
    res.status(500).json({ error: "Failed to load quotation" });
  }
});

// POST /api/parse/:quotationId/confirm — Save user's HIL selections
parseRouter.post("/:quotationId/confirm", async (req, res) => {
  const { quotationId } = req.params;
  const { selections } = req.body as {
    selections?: Record<string, string | null>;
  };

  if (!selections) {
    res.status(400).json({ error: "selections is required" });
    return;
  }

  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
    include: { items: true },
  });

  if (!quotation) {
    res.status(404).json({ error: "Quotation not found" });
    return;
  }

  // Apply user selections: rawSku → productId (null means skip)
  const updates: Promise<unknown>[] = [];
  for (const [rawSku, productId] of Object.entries(selections)) {
    const items = quotation.items.filter((i) => i.rawSku === rawSku);
    for (const item of items) {
      updates.push(
        prisma.quotationItem.update({
          where: { id: item.id },
          data: {
            productId: productId,
            matchConfidence: productId ? 1.0 : 0,
            matchMethod: productId ? "user_confirmed" : "user_skipped",
          },
        }),
      );
    }
  }

  await Promise.all(updates);

  console.log(
    `parse: Confirmed ${Object.keys(selections).length} selections for quotation ${quotationId}`,
  );

  res.json({ ok: true });
});

// PUT /api/parse/:quotationId/supplier — Change quotation's supplier to an existing one
parseRouter.put("/:quotationId/supplier", async (req, res) => {
  try {
    const { quotationId } = req.params;
    const { supplierId } = req.body as { supplierId?: string };

    if (!supplierId) {
      res.status(400).json({ error: "supplierId is required" });
      return;
    }

    const quotation = await prisma.quotation.findUnique({ where: { id: quotationId } });
    if (!quotation) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }

    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierId, organizationId: quotation.organizationId },
    });
    if (!supplier) {
      res.status(404).json({ error: "Supplier not found in this organization" });
      return;
    }

    await prisma.quotation.update({
      where: { id: quotationId },
      data: { supplierId: supplier.id },
    });

    console.log(`parse: Updated quotation ${quotationId} supplier to ${supplier.code} (${supplier.name})`);
    res.json({ ok: true, supplier: toSupplierProfile(supplier) });
  } catch (error) {
    console.error("Failed to update quotation supplier:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update supplier" });
  }
});

// POST /api/parse/:quotationId/create-supplier — Create a new supplier and assign to quotation
parseRouter.post("/:quotationId/create-supplier", async (req, res) => {
  try {
    const { quotationId } = req.params;
    const { name } = req.body as { name?: string };

    if (!name?.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const quotation = await prisma.quotation.findUnique({ where: { id: quotationId } });
    if (!quotation) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }

    // Auto-generate next SUP-XXX code
    const existingSuppliers = await prisma.supplier.findMany({
      where: { organizationId: quotation.organizationId },
      select: { code: true },
      orderBy: { code: "desc" },
    });

    let nextNumber = 1;
    for (const s of existingSuppliers) {
      const match = s.code.match(/^SUP-(\d+)$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num >= nextNumber) nextNumber = num + 1;
      }
    }
    const code = `SUP-${String(nextNumber).padStart(3, "0")}`;

    const supplier = await prisma.supplier.create({
      data: {
        organizationId: quotation.organizationId,
        code,
        name: name.trim(),
        qualityRating: 4.0,
        priceLevel: "cheapest",
        leadTimeDays: 50,
        paymentTerms: "33/33/33",
      },
    });

    // Update quotation to point to the new supplier
    await prisma.quotation.update({
      where: { id: quotationId },
      data: { supplierId: supplier.id },
    });

    console.log(`parse: Created new supplier ${code} "${name.trim()}" and assigned to quotation ${quotationId}`);
    res.json(toSupplierProfile(supplier));
  } catch (error) {
    console.error("Failed to create supplier:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to create supplier" });
  }
});

parseRouter.post("/", upload.single("file"), async (req, res) => {
  const startTime = Date.now();

  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const notes = req.body?.notes as string | undefined;

    console.log(`\n=== PARSE REQUEST: ${req.file.originalname} (${req.file.size} bytes) ===`);

    // Stage 1: Mechanical extraction with exceljs (all sheets)
    const t1 = Date.now();
    const workbook = await readXlsx(req.file.buffer);
    const t2 = Date.now();

    // Stage 2: LLM interpretation (items + metadata in one pass)
    const structureResult = await structureWithLlm(workbook);
    const t3 = Date.now();
    const items = structureResult.items;

    // Extract supplier name from sheet metadata (first non-null supplierName wins)
    let extractedSupplierName: string | null = null;
    for (const [, meta] of structureResult.sheetMetadata) {
      if (meta.supplierName) {
        extractedSupplierName = meta.supplierName;
        break;
      }
    }
    console.log(`parse: Supplier from metadata: ${extractedSupplierName ?? "(not found, will try fallback)"}`);

    // Fallback: if metadata didn't find supplier name, try dedicated extraction
    if (!extractedSupplierName) {
      extractedSupplierName = await extractSupplierName(workbook);
    }

    // Stage 3: Fast arithmetic pre-check, then full validation if needed
    // Quick scan: if all items have consistent qty × price = total, skip expensive LLM validation
    let validationFlags: ValidationFlag[] = [];
    const needsValidation = items.some((item, idx) => {
      if (item.rawQuantity == null || item.rawUnitPrice == null) return false; // No qty/price to validate
      if (item.rawTotalPrice == null) return false; // No total to validate against
      const computed = Math.round(item.rawQuantity * item.rawUnitPrice * 100) / 100;
      const extracted = Math.round(item.rawTotalPrice * 100) / 100;
      const diff = Math.abs(computed - extracted);
      return diff > 0.02; // Flag if difference > 2 cents (rounding tolerance)
    });

    if (needsValidation) {
      console.log(`parse: Arithmetic inconsistencies detected, running full validation...`);
      validationFlags = await validateExtraction(workbook, items);
    } else {
      console.log(`parse: All arithmetic checks passed, skipping LLM validation (fast path)`);
    }

    const t4 = Date.now();

    // Stage 4: Product matching (fuse.js 3-tier + LLM fallback)
    const matches = await matchProducts(items, validationFlags);
    const t5 = Date.now();

    // Stage 5: Group by SKU
    const products = groupBySku(items, matches, validationFlags);

    // Stage 6: Match supplier + save to database
    const organizationId = await getOrg();
    const { supplierMatch, allSuppliers, fallbackSupplierId } = await matchSupplier(organizationId, extractedSupplierName);

    const supplierId = supplierMatch.matched ? supplierMatch.supplier.id : fallbackSupplierId;
    const supplierName = supplierMatch.matched ? supplierMatch.supplier.name : (extractedSupplierName ?? "Unknown Supplier");
    const supplierCode = supplierMatch.matched ? supplierMatch.supplier.code : "UNMATCHED";

    console.log(`parse: Supplier match — ${supplierMatch.matched ? `found "${supplierName}" (${supplierCode})` : `not found, extracted="${extractedSupplierName}"`}`);

    // Build sheet metadata object (for DB storage and frontend response)
    const sheetMetadataObj: Record<string, SheetMetadata> = {};
    for (const [sheetName, meta] of structureResult.sheetMetadata) {
      const hasData = Object.values(meta).some(Boolean);
      if (hasData) {
        sheetMetadataObj[sheetName] = meta;
      }
    }

    const quotation = await prisma.quotation.create({
      data: {
        organizationId,
        supplierId,
        fileName: req.file.originalname,
        notes: notes ?? null,
        rawData: JSON.parse(JSON.stringify({
          sheets: workbook.sheets.map((s) => ({
            sheetName: s.sheetName,
            sheetIndex: s.sheetIndex,
            rows: s.grid.length,
            cols: s.grid[0]?.length ?? 0,
          })),
          sheetMetadata: sheetMetadataObj,
        })),
        items: {
          create: items.map((item, idx) => {
            const match = matches[idx];
            const qty = item.rawQuantity ?? 0;
            const unit = item.rawUnitPrice ?? 0;
            // Always compute totalPrice from qty * unit — never trust extracted total
            const computedTotal = Math.round(qty * unit * 100) / 100;
            return {
              rawSku: item.rawSku,
              rawDescription: item.rawDescription,
              rawQuantity: String(item.rawQuantity ?? ""),
              rawUnitPrice: String(item.rawUnitPrice ?? ""),
              rawTotalPrice: item.rawTotalPrice != null ? String(item.rawTotalPrice) : null,
              rawNotes: item.rawNotes,
              productId: match.productId,
              matchConfidence: match.confidence,
              matchMethod: match.method,
              quantity: qty,
              unitPrice: unit,
              totalPrice: computedTotal > 0 ? computedTotal : (item.rawTotalPrice ?? 0),
            };
          }),
        },
      },
    });

    console.log(`parse: Saved quotation ${quotation.id} with ${items.length} items`);

    // Compute match summary
    const autoAccepted = products.filter((p) => p.matchConfidence >= 0.85).length;
    const needsReview = products.filter((p) => p.matchConfidence >= 0.5 && p.matchConfidence < 0.85).length;
    const needsAction = products.filter((p) => p.matchConfidence > 0 && p.matchConfidence < 0.5).length;
    const unmatched = products.filter((p) => p.matchConfidence === 0).length;

    const elapsed = Date.now() - startTime;

    // Store parseMetadata for orchestration visualization
    const parseMetadata = {
      timings: {
        totalMs: elapsed,
        xlsxReadMs: t2 - t1,
        llmStructureMs: t3 - t2,
        validationMs: t4 - t3,
        matchingMs: t5 - t4,
      },
      matchSummary: {
        totalProducts: products.length,
        totalRawRows: items.length,
        autoAccepted,
        needsReview,
        needsAction,
        unmatched,
      },
      sheets: workbook.sheets.map((s) => ({
        sheetName: s.sheetName,
        rows: s.grid.length,
        cols: s.grid[0]?.length ?? 0,
      })),
      validation: {
        arithmeticCheckPassed: !needsValidation,
        flagCount: validationFlags.length,
      },
      supplierExtraction: {
        found: !!extractedSupplierName,
        name: extractedSupplierName,
        matched: supplierMatch.matched,
      },
    };

    await prisma.quotation.update({
      where: { id: quotation.id },
      data: { parseMetadata: JSON.parse(JSON.stringify(parseMetadata)) },
    });
    console.log(`=== PARSE COMPLETE in ${elapsed}ms — ${items.length} raw rows → ${products.length} unique products ===`);
    console.log(`    Matches: ${autoAccepted} auto-accepted, ${needsReview} review, ${needsAction} needs action, ${unmatched} unmatched`);
    console.log(`    Sheets: ${workbook.sheets.map((s) => s.sheetName).join(", ")}\n`);

    res.json({
      quotationId: quotation.id,
      supplierName,
      supplierCode,
      supplierMatch,
      allSuppliers,
      products,
      matchSummary: {
        totalProducts: products.length,
        totalRawRows: items.length,
        autoAccepted,
        needsReview,
        needsAction,
        unmatched,
      },
      sheets: workbook.sheets.map((s) => ({
        sheetName: s.sheetName,
        sheetIndex: s.sheetIndex,
        rows: s.grid.length,
        cols: s.grid[0]?.length ?? 0,
      })),
      notes: notes ?? null,
      sheetMetadata: Object.keys(sheetMetadataObj).length > 0 ? sheetMetadataObj : undefined,
    });
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(`Parse failed after ${elapsed}ms:`, error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Parse failed",
    });
  }
});
