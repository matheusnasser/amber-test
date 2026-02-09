import Fuse from "fuse.js";
import { generateObject } from "ai";
import { z } from "zod";
import { prisma } from "@supplier-negotiation/database";
import { matcherModel } from "../lib/ai";
import type { RawParsedItem } from "../parser/llm-structurer";
import type { ValidationFlag } from "../parser/llm-validator";

type MatchMethod = "exact_sku" | "llm_match" | "unmatched";

export interface CandidateProduct {
  productId: string;
  sku: string;
  name: string;
  color: string;
  confidence: number;
}

export interface MatchResult {
  itemIndex: number;
  productId: string | null;
  matchedSku: string | null;
  confidence: number;
  method: MatchMethod;
  productName: string | null;
  candidates: CandidateProduct[];
}

interface ProductRecord {
  id: string;
  sku: string;
  name: string;
  brand: string;
  color: string;
  skuPrefix: string;
}

// ─── Cached product data (loaded once per process) ────────────────────────────

let cachedProducts: ProductRecord[] | null = null;
let skuMap: Map<string, ProductRecord> | null = null;
let skuFuse: Fuse<ProductRecord> | null = null;
let nameFuse: Fuse<{ name: string; product: ProductRecord }> | null = null;

async function loadProducts(): Promise<void> {
  if (cachedProducts) return;

  const startTime = Date.now();
  console.log("product-matcher: Loading products from database...");

  const products = await prisma.product.findMany({
    select: { id: true, sku: true, name: true, brand: true, color: true, skuPrefix: true },
  });

  cachedProducts = products;
  ocrMap = null; // invalidate OCR map on reload

  // Exact SKU lookup map (uppercase)
  skuMap = new Map();
  for (const product of products) {
    skuMap.set(product.sku.toUpperCase(), product);
  }

  // Fuse index for SKU fuzzy ranking
  skuFuse = new Fuse(products, {
    keys: ["sku"],
    threshold: 0.6, // wider threshold — we're ranking, not deciding
    includeScore: true,
  });

  // Fuse index for name fuzzy ranking (deduplicated by name)
  const nameMap = new Map<string, ProductRecord>();
  for (const product of products) {
    if (!nameMap.has(product.name)) {
      nameMap.set(product.name, product);
    }
  }
  const uniqueByName = Array.from(nameMap.entries()).map(([name, product]) => ({
    name,
    product,
  }));
  nameFuse = new Fuse(uniqueByName, {
    keys: ["name"],
    threshold: 0.6,
    includeScore: true,
  });

  const elapsed = Date.now() - startTime;
  console.log(
    `product-matcher: Loaded ${products.length} products, ${nameMap.size} unique names in ${elapsed}ms`,
  );
}

// ─── SKU normalization ────────────────────────────────────────────────────────

function cleanSku(rawSku: string): string {
  return rawSku
    .trim()
    .toUpperCase()
    .replace(/\u2013|\u2014/g, "-") // normalize em/en dashes
    .replace(/\s+/g, "-")           // spaces to dashes
    .replace(/-+/g, "-")            // collapse multiple dashes
    .replace(/^-|-$/g, "");         // trim leading/trailing dashes
}

// ─── Tier 1: Exact SKU match ─────────────────────────────────────────────────

function matchExactSku(cleanedSku: string): MatchResult | null {
  const product = skuMap!.get(cleanedSku);
  if (!product) return null;

  return {
    itemIndex: -1,
    productId: product.id,
    matchedSku: product.sku,
    confidence: 1.0,
    method: "exact_sku",
    productName: product.name,
    candidates: [],
  };
}

// ─── Tier 1.5: OCR-normalized SKU match ─────────────────────────────────────
// Catches O↔0, I↔1↔l, K↔Q swaps without burning LLM tokens

function normalizeOcr(sku: string): string {
  return sku
    .replace(/O/gi, "0")   // O → 0
    .replace(/[Il]/g, "1") // I, l → 1
    .replace(/Q/gi, "K")   // Q → K
    .replace(/Z/gi, "2")   // Z → 2
    .replace(/S/gi, "5")   // S → 5 (less common, but free)
    .replace(/B/gi, "8");  // B → 8
}

let ocrMap: Map<string, ProductRecord[]> | null = null;

function buildOcrMap(): void {
  if (ocrMap) return;
  ocrMap = new Map();
  for (const product of cachedProducts!) {
    const normalized = normalizeOcr(product.sku.toUpperCase());
    const existing = ocrMap.get(normalized);
    if (existing) {
      existing.push(product);
    } else {
      ocrMap.set(normalized, [product]);
    }
  }
}

function matchOcrNormalized(cleanedSku: string): MatchResult | null {
  buildOcrMap();
  const normalized = normalizeOcr(cleanedSku);
  const matches = ocrMap!.get(normalized);
  if (!matches || matches.length === 0) return null;

  // If multiple products share the same OCR-normalized SKU, pick the one
  // whose original SKU is closest to the input
  const best = matches.length === 1
    ? matches[0]
    : matches.reduce((a, b) =>
        levenshtein(a.sku.toUpperCase(), cleanedSku) <= levenshtein(b.sku.toUpperCase(), cleanedSku) ? a : b
      );

  return {
    itemIndex: -1,
    productId: best.id,
    matchedSku: best.sku,
    confidence: 0.95, // high but not 1.0 — human can still review
    method: "exact_sku", // treated as near-exact
    productName: best.name,
    candidates: [],
  };
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// ─── Tier 2A: Fuzzy candidate ranking (fuse.js — ranking only, no decisions) ─

interface RankedCandidate {
  productId: string;
  sku: string;
  name: string;
  color: string;
  skuPrefix: string;
  skuDistance: number;  // fuse score (0 = perfect, 1 = worst)
  nameDistance: number; // fuse score from name search
}

function buildCandidateRanking(cleanedSku: string, rawDescription: string): RankedCandidate[] {
  const skuResults = skuFuse!.search(cleanedSku, { limit: 10 });
  const nameResults = nameFuse!.search(rawDescription, { limit: 10 });

  const candidateMap = new Map<string, RankedCandidate>();

  // Add SKU matches
  for (const r of skuResults) {
    candidateMap.set(r.item.id, {
      productId: r.item.id,
      sku: r.item.sku,
      name: r.item.name,
      color: r.item.color,
      skuPrefix: r.item.skuPrefix,
      skuDistance: r.score ?? 1,
      nameDistance: 1, // will be updated if also found by name
    });
  }

  // Add/merge name matches
  for (const r of nameResults) {
    const product = r.item.product;
    const existing = candidateMap.get(product.id);
    if (existing) {
      existing.nameDistance = r.score ?? 1;
    } else {
      candidateMap.set(product.id, {
        productId: product.id,
        sku: product.sku,
        name: r.item.name,
        color: product.color,
        skuPrefix: product.skuPrefix,
        skuDistance: 1,
        nameDistance: r.score ?? 1,
      });
    }
  }

  // Sort by best score (lowest distance wins)
  return Array.from(candidateMap.values())
    .sort((a, b) => Math.min(a.skuDistance, a.nameDistance) - Math.min(b.skuDistance, b.nameDistance))
    .slice(0, 10);
}

function candidatesToExport(candidates: RankedCandidate[]): CandidateProduct[] {
  return candidates.map((c) => ({
    productId: c.productId,
    sku: c.sku,
    name: c.name,
    color: c.color,
    confidence: 1 - Math.min(c.skuDistance, c.nameDistance),
  }));
}

// ─── Tier 2B: Batched LLM matching ───────────────────────────────────────────

const LLM_MATCH_BATCH_SIZE = 10;
const LLM_CONFIDENCE_THRESHOLD = 0.6;

interface PendingMatch {
  index: number;
  rawSku: string;
  rawDescription: string;
  cleanedSku: string;
  candidates: RankedCandidate[];
}

const batchMatchSchema = z.object({
  matches: z.array(
    z.object({
      itemIndex: z.number().describe("The index of the item in the batch (0-based)"),
      matchedSku: z
        .string()
        .nullable()
        .describe("The catalog SKU that best matches this item, or null if no confident match"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("Confidence score 0-1 (0 = no match, 1 = certain match)"),
      reasoning: z
        .string()
        .describe("Brief explanation of why this match was chosen or rejected"),
    }),
  ),
});

function buildBatchPrompt(batch: PendingMatch[]): string {
  const itemsSection = batch
    .map((item, batchIdx) => {
      const candidateRows = item.candidates
        .map(
          (c) =>
            `    ${c.sku} | ${c.name} | ${c.color} | SKU dist: ${c.skuDistance.toFixed(3)} | Name dist: ${c.nameDistance.toFixed(3)}`,
        )
        .join("\n");

      return `--- Item ${batchIdx} ---
Spreadsheet SKU: ${item.rawSku}
Spreadsheet Description: ${item.rawDescription}
Cleaned SKU: ${item.cleanedSku}
Top candidates (sorted by similarity):
${candidateRows || "    (no candidates found)"}`;
    })
    .join("\n\n");

  return `You are a product SKU matching specialist for an outdoor gear catalog.

<context>
Our catalog SKUs follow the pattern: PREFIX-COLORCODE-SIZECODE
Examples: MC001-GLW-XL, OB007-BAS-L, MAS001-ICB-XL, AK009-0BS-XS
</context>

<common_typos>
Spreadsheet SKUs from suppliers are full of OCR errors, manual entry mistakes, and software artifacts. Here are the known error patterns — all examples below represent the SAME product:

VISUALLY SIMILAR CHARACTERS (most frequent):
- 0 ↔ O (zero vs letter O): MH010-OBS-M = MH010-0BS-M, AK009-OBS-XS = AK009-0BS-XS
- 1 ↔ I ↔ l (one vs I vs L): MB0I3-0BS-XL = MB013-0BS-XL
- K ↔ Q (visually similar in print): AQ009-0BS-XS = AK009-0BS-XS
- 8 ↔ B, 5 ↔ S, 2 ↔ Z (OCR misreads)

FORMATTING ERRORS:
- Missing/extra/inconsistent dashes: MC001GLW-XL = MC001-GLW-XL
- Leading zeros dropped by Excel: 01234-BLK-M = 1234-BLK-M
- Case changes: mc001-glw-xl = MC001-GLW-XL
- Spaces or slashes instead of dashes: MC001 GLW XL = MC001/GLW/XL = MC001-GLW-XL

STRUCTURAL ERRORS:
- Transposed characters: MC010-GLW-XL = MC001-GLW-XL
- Missing size segment: MC001-GLW = MC001-GLW-XL
- Description used as SKU: "HMS Twist-Lock Glacier White XL" = MC001-GLW-XL

COMBINED ERRORS (multiple patterns at once):
- AQ009-OBS-XS = AK009-0BS-XS (K↔Q swap + O↔0 swap — this is ONE product!)
- MH0I0-OBS-M = MH010-0BS-M (I↔1 swap + O↔0 swap)
</common_typos>

<instructions>
For each spreadsheet item, compare against the candidate catalog SKUs and decide the best match.

Step-by-step process:
1. Normalize both SKUs mentally: replace O→0, I→1, l→1, Q→K, remove dashes, uppercase everything. Do they match now?
2. If normalized forms match → confidence 0.90–0.95.
3. If normalized forms differ by only 1-2 characters and the product name/description also aligns → confidence 0.85–0.92.
4. If the product description from the spreadsheet clearly matches a candidate's product name, that is strong confirming evidence even if the SKU is garbled → confidence 0.80–0.90.
5. If there is real ambiguity (multiple plausible candidates, or the SKU structure doesn't align) → confidence 0.60–0.79.
6. If no reasonable match exists → return null matchedSku with confidence 0.

Confidence scale:
- 0.90–0.95: Near-certain match (differs only by known typo patterns above)
- 0.85–0.89: Very likely match (strong SKU + name evidence)
- 0.70–0.84: Probable match (good evidence but some ambiguity)
- 0.60–0.69: Possible match (needs human review)
- Below 0.60: Do not match — return null

NEVER return confidence 1.0 — that is reserved for exact string matches only.
NEVER return confidence above 0.95.
A wrong match is FAR worse than sending to human review. When in doubt, return null.
</instructions>

<items>
${itemsSection}
</items>

Return a match decision for EACH of the ${batch.length} items.`;
}

async function matchBatchWithLlm(batch: PendingMatch[]): Promise<Map<number, { matchedSku: string | null; confidence: number; reasoning: string }>> {
  const startTime = Date.now();
  console.log(
    `product-matcher: LLM batch matching ${batch.length} items...`,
  );

  const prompt = buildBatchPrompt(batch);
  const results = new Map<number, { matchedSku: string | null; confidence: number; reasoning: string }>();

  try {
    const { object } = await generateObject({
      model: matcherModel,
      schema: batchMatchSchema,
      prompt,
      temperature: 0,
    });

    for (const match of object.matches) {
      if (match.itemIndex >= 0 && match.itemIndex < batch.length) {
        results.set(match.itemIndex, {
          matchedSku: match.matchedSku,
          confidence: match.confidence,
          reasoning: match.reasoning,
        });
      }
    }

    const elapsed = Date.now() - startTime;
    const matched = object.matches.filter((m) => m.matchedSku && m.confidence >= LLM_CONFIDENCE_THRESHOLD).length;
    console.log(
      `product-matcher: LLM batch done in ${elapsed}ms — ${matched}/${batch.length} matched above threshold`,
    );
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error(
      `product-matcher: LLM batch failed after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return results;
}

// ─── Main matching function ──────────────────────────────────────────────────

export async function matchProducts(
  items: RawParsedItem[],
  validationFlags: ValidationFlag[],
): Promise<MatchResult[]> {
  await loadProducts();

  const totalStart = Date.now();
  console.log(`product-matcher: Matching ${items.length} items...`);

  const flaggedIndices = new Set(validationFlags.map((f) => f.itemIndex));
  const results: MatchResult[] = new Array(items.length);
  const pendingItems: PendingMatch[] = [];

  let exactCount = 0;

  // Phase 1: Try exact SKU match for every item, collect non-matches for LLM
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const cleanedSku = cleanSku(item.rawSku);

    // Tier 1: Exact SKU
    const exactMatch = matchExactSku(cleanedSku);
    if (exactMatch) {
      exactMatch.itemIndex = i;
      results[i] = exactMatch;
      exactCount++;
      continue;
    }

    // Tier 1.5: OCR-normalized SKU (O↔0, I↔1, K↔Q, etc.)
    const ocrMatch = matchOcrNormalized(cleanedSku);
    if (ocrMatch) {
      ocrMatch.itemIndex = i;
      results[i] = ocrMatch;
      exactCount++; // count as near-exact
      console.log(`  OCR-normalized "${item.rawSku}" → ${ocrMatch.matchedSku} (0.95)`);
      continue;
    }

    // Tier 2+: Build fuzzy ranking for LLM
    {
      const candidates = buildCandidateRanking(cleanedSku, item.rawDescription);
      pendingItems.push({
        index: i,
        rawSku: item.rawSku,
        rawDescription: item.rawDescription,
        cleanedSku,
        candidates,
      });
    }
  }

  console.log(
    `product-matcher: ${exactCount} exact matches, ${pendingItems.length} items need LLM matching`,
  );

  // Phase 2: Send non-exact items to LLM in batches
  let llmCount = 0;
  let unmatchedCount = 0;

  for (let batchStart = 0; batchStart < pendingItems.length; batchStart += LLM_MATCH_BATCH_SIZE) {
    const batch = pendingItems.slice(batchStart, batchStart + LLM_MATCH_BATCH_SIZE);
    const batchResults = await matchBatchWithLlm(batch);

    for (let batchIdx = 0; batchIdx < batch.length; batchIdx++) {
      const pending = batch[batchIdx];
      const llmResult = batchResults.get(batchIdx);
      const exportCandidates = candidatesToExport(pending.candidates);

      if (llmResult?.matchedSku && llmResult.confidence >= LLM_CONFIDENCE_THRESHOLD) {
        // LLM found a match with sufficient confidence — cap at 0.95 (only exact_sku gets 1.0)
        const product = skuMap!.get(llmResult.matchedSku.toUpperCase());
        if (product) {
          const cappedConfidence = Math.min(llmResult.confidence, 0.95);
          console.log(
            `  LLM matched "${pending.rawSku}" → ${product.sku} (${cappedConfidence.toFixed(2)}) — ${llmResult.reasoning}`,
          );
          results[pending.index] = {
            itemIndex: pending.index,
            productId: product.id,
            matchedSku: product.sku,
            confidence: cappedConfidence,
            method: "llm_match",
            productName: product.name,
            candidates: exportCandidates,
          };
          llmCount++;
          continue;
        }
      }

      // Unmatched — goes to HIL
      console.log(
        `  Unmatched "${pending.rawSku}" — ${llmResult ? `LLM confidence ${llmResult.confidence.toFixed(2)}: ${llmResult.reasoning}` : "no LLM response"}`,
      );
      results[pending.index] = {
        itemIndex: pending.index,
        productId: null,
        matchedSku: null,
        confidence: 0,
        method: "unmatched",
        productName: null,
        candidates: exportCandidates,
      };
      unmatchedCount++;
    }
  }

  // Phase 3: Apply validation penalty
  for (let i = 0; i < results.length; i++) {
    if (flaggedIndices.has(i) && results[i].method !== "exact_sku") {
      results[i].confidence = Math.max(0, results[i].confidence - 0.2);
    }
  }

  const elapsed = Date.now() - totalStart;
  console.log(
    `product-matcher: Done in ${elapsed}ms — exact: ${exactCount}, llm: ${llmCount}, unmatched: ${unmatchedCount}`,
  );

  return results;
}
