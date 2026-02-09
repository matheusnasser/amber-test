/**
 * AI Model Configuration
 * Centralized configuration for all AI models and concurrency management
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { ChatAnthropic } from "@langchain/anthropic";
import { getConcurrencyLimits } from "../config/business-rules";

// ─── Model Configuration ────────────────────────────────────────────────────

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Model definitions with their use cases
 * Using Haiku for fast, parallel tasks and Sonnet for complex reasoning
 */
export const AI_MODELS = {
  // Vercel AI SDK models (for structured output with native Zod validation)
  structurer: anthropic("claude-haiku-4-5-20251001"), // Structured data extraction
  validator: anthropic("claude-haiku-4-5-20251001"),  // Data validation
  matcher: anthropic("claude-haiku-4-5-20251001"),    // Product matching
  extractor: anthropic("claude-haiku-4-5-20251001"),  // Offer extraction
  reasoning: anthropic("claude-sonnet-4-5-20250929"), // Complex reasoning (curveball, decisions)
} as const;

/**
 * LangChain models (for agent conversations)
 */
export const LANGCHAIN_MODELS = {
  pillar: new ChatAnthropic({
    model: "claude-haiku-4-5-20251001",
    temperature: 0.5,
    maxRetries: 3,
  }),
  synthesizer: new ChatAnthropic({
    model: "claude-haiku-4-5-20251001",
    temperature: 0.7,
    maxRetries: 2,
    maxTokens: 250,
  }),
  agent: new ChatAnthropic({
    model: "claude-sonnet-4-5-20250929",
    temperature: 0.7,
    maxRetries: 2,
    maxTokens: 250,
  }),
} as const;

// Legacy exports for backward compatibility
export const structurerModel = AI_MODELS.structurer;
export const validatorModel = AI_MODELS.validator;
export const matcherModel = AI_MODELS.matcher;
export const extractorModel = AI_MODELS.extractor;
export const reasoningModel = AI_MODELS.reasoning;
export const pillarModel = LANGCHAIN_MODELS.pillar;
export const synthesizerModel = LANGCHAIN_MODELS.synthesizer;
export const agentModel = LANGCHAIN_MODELS.agent;

// ─── Concurrency Management ─────────────────────────────────────────────────

/**
 * Semaphore for rate limiting concurrent API calls
 * Prevents hitting Anthropic's rate limits
 */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  /** Get current usage stats */
  get stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
    };
  }
}

// Get limits from business rules config
const limits = getConcurrencyLimits();

/** Haiku semaphore: controls concurrent Haiku model calls */
export const haikuSemaphore = new Semaphore(limits.haiku);

/** Sonnet semaphore: controls concurrent Sonnet model calls */
export const sonnetSemaphore = new Semaphore(limits.sonnet);

/**
 * Run an async function with semaphore-based rate limiting
 * Automatically acquires before and releases after (even on error)
 */
export async function withSemaphore<T>(
  sem: Semaphore,
  fn: () => Promise<T>,
): Promise<T> {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

// ─── Cost Tracking ──────────────────────────────────────────────────────────

/**
 * Pricing per 1M tokens (as of February 2026)
 * Source: Anthropic pricing page
 * Only includes models actually used in this project
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },   // Haiku 4.5 - pillars, extraction
  "claude-sonnet-4-5-20250929": { input: 3.0, output: 15.0 }, // Sonnet 4.5 - agents, reasoning
};

/**
 * Tracks AI usage and costs for a single negotiation
 */
export class CostTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;

  track(model: string, inputTokens: number, outputTokens: number) {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    
    const pricing = PRICING[model] ?? PRICING["claude-sonnet-4-5-20250929"];
    this.totalCostUsd +=
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;
  }

  get totals() {
    return {
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      totalCostUsd: Math.round(this.totalCostUsd * 10000) / 10000,
    };
  }

  /** Reset all counters */
  reset() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCostUsd = 0;
  }
}

/** Global cost trackers keyed by negotiationId */
const costTrackers = new Map<string, CostTracker>();

/**
 * Get or create a cost tracker for a negotiation
 */
export function getCostTracker(negotiationId: string): CostTracker {
  if (!costTrackers.has(negotiationId)) {
    costTrackers.set(negotiationId, new CostTracker());
  }
  return costTrackers.get(negotiationId)!;
}

/**
 * Remove a cost tracker (cleanup after negotiation completes)
 */
export function removeCostTracker(negotiationId: string) {
  costTrackers.delete(negotiationId);
}

/**
 * Extract token usage from a LangChain AIMessage and track it
 */
export function trackUsage(
  negotiationId: string,
  model: string,
  response: {
    usage_metadata?: { input_tokens?: number; output_tokens?: number };
  },
) {
  const meta = response.usage_metadata;
  if (meta) {
    getCostTracker(negotiationId).track(
      model,
      meta.input_tokens ?? 0,
      meta.output_tokens ?? 0,
    );
  }
}

/**
 * Get all active cost trackers (for monitoring/debugging)
 */
export function getAllCostTrackers(): Map<string, CostTracker> {
  return new Map(costTrackers);
}
