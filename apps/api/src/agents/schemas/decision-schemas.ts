/**
 * Zod Schemas for Decision Maker
 * Centralized schema definitions for LLM-generated structured outputs
 */

import { z } from "zod";

/**
 * Schema for curveball analysis response
 * Used when supplier announces capacity constraints or other disruptions
 */
export const curveballAnalysisSchema = z.object({
  impact: z.string().describe("1-2 sentences describing the immediate impact"),
  strategies: z
    .array(
      z.object({
        name: z.string().describe("Short strategy name"),
        description: z.string().describe("1-2 sentence description"),
        suppliers: z.array(
          z.object({
            supplierId: z.string(),
            supplierName: z.string(),
            allocationPct: z.number().describe("Percentage of total order"),
          }),
        ),
        estimatedCost: z.number().describe("Estimated total cost"),
        pros: z.array(z.string()),
        cons: z.array(z.string()),
      }),
    )
    .describe("2-3 strategies to handle the curveball"),
  recommendation: z.string().describe("Which strategy is recommended and why"),
});

/**
 * Schema for final decision recommendation
 * Used for final supplier selection after all negotiation rounds
 */
export const finalDecisionSchema = z.object({
  recommendation: z.object({
    primarySupplierId: z.string(),
    primarySupplierName: z.string(),
    splitOrder: z.boolean(),
    allocations: z.array(
      z.object({
        supplierId: z.string(),
        supplierName: z.string(),
        allocationPct: z.number(),
        agreedCost: z.number(),
        leadTimeDays: z.number(),
        paymentTerms: z.string(),
      }),
    ),
  }),
  comparison: z.array(
    z.object({
      supplierId: z.string(),
      supplierName: z.string(),
      costScore: z.number().min(0).max(100),
      qualityScore: z.number().min(0).max(100),
      leadTimeScore: z.number().min(0).max(100),
      termsScore: z.number().min(0).max(100),
      totalScore: z.number().min(0).max(100),
    }),
  ),
  summary: z
    .string()
    .describe(
      "2-3 sentence executive summary of the decision. Focus on WHY this is the best choice given the user's stated priorities and constraints — not just the cheapest option. Mention the key tradeoff that was made.",
    ),
  keyPoints: z
    .array(
      z.object({
        dimension: z.enum(["price", "quality", "leadTime", "cashFlow", "risk"]),
        verdict: z
          .string()
          .describe("One sentence: what was decided on this dimension"),
        winner: z.string().describe("Which supplier won on this dimension"),
      }),
    )
    .describe(
      "One key point per scoring dimension — price, quality, leadTime, cashFlow, risk",
    ),
  reasoning: z
    .string()
    .describe(
      "Comprehensive justification using markdown with headers (## Price Analysis, ## Quality Assessment, ## Lead Time & Logistics, ## Cash Flow Impact, ## Risk Assessment, ## Quantity Verification). Include specific dollar amounts, percentages, and SKU references. Max 800 words.",
    ),
  tradeoffs: z
    .string()
    .describe(
      "Key tradeoffs using markdown bullet points. For each: what was gained, what was sacrificed, and why. Max 300 words.",
    ),
});

export type CurveballAnalysisOutput = z.infer<typeof curveballAnalysisSchema>;
export type FinalDecisionOutput = z.infer<typeof finalDecisionSchema>;
