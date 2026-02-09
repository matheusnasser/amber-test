import { Router } from "express";
import { prisma } from "@supplier-negotiation/database";
import { analyzeCurveball, generateFinalDecision } from "../agents/decision-maker";
import { runPostCurveballRounds } from "../agents/negotiation-loop";
import { emitNegotiationEvent } from "../lib/event-bus";

export const curveballRouter = Router();

// POST /api/curveball — Run curveball pipeline, stream events via SSE
curveballRouter.post("/", async (req, res) => {
  const { negotiationId } = req.body as { negotiationId?: string };

  if (!negotiationId) {
    res.status(400).json({ error: "negotiationId is required" });
    return;
  }

  const negotiation = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
  });

  if (!negotiation) {
    res.status(404).json({ error: "Negotiation not found" });
    return;
  }

  // Find Supplier 2 (SUP-002) — the affected supplier
  const affectedSupplier = await prisma.supplier.findFirst({
    where: {
      organizationId: negotiation.organizationId,
      code: "SUP-002",
    },
  });

  if (!affectedSupplier) {
    res.status(404).json({ error: "Affected supplier (SUP-002) not found" });
    return;
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let clientDisconnected = false;
  req.on("close", () => {
    clientDisconnected = true;
    console.log(`curveball: Client disconnected for ${negotiationId}`);
  });

  const emit = (event: Record<string, unknown>) => {
    // Emit to event bus for SSE subscribers (orchestration page)
    emitNegotiationEvent(negotiationId, event);

    if (clientDisconnected) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const curveballDescription =
    `${affectedSupplier.name} (${affectedSupplier.code}) came back saying they can only fulfill 60% of the order`;

  try {
    console.log(
      `\n=== CURVEBALL PIPELINE: ${negotiationId} ===`,
    );

    // 1. Inject curveball
    emit({
      type: "curveball_injected",
      description: curveballDescription,
    });

    // 2. Analyze curveball — GPT-4o produces strategies
    console.log("curveball: Analyzing impact...");
    const analysis = await analyzeCurveball(
      negotiationId,
      affectedSupplier.id,
      curveballDescription,
    );

    emit({
      type: "strategy_proposed",
      analysis,
    });

    // 3. Run post-curveball negotiation rounds (full round budget, fresh approach)
    console.log("curveball: Running post-curveball rounds...");
    await runPostCurveballRounds({
      negotiationId,
      curveballDescription,
      affectedSupplierId: affectedSupplier.id,
      curveballAnalysis: analysis,
      onEvent: (event) => {
        emit(event as unknown as Record<string, unknown>);
      },
    });

    // 4. Generate final decision — GPT-4o produces recommendation + comparison
    console.log("curveball: Generating final decision...");
    const decision = await generateFinalDecision(negotiationId);

    emit({
      type: "decision",
      recommendation: decision.recommendation,
      comparison: decision.comparison,
      summary: decision.summary,
      keyPoints: decision.keyPoints,
      reasoning: decision.reasoning,
      tradeoffs: decision.tradeoffs,
      allSupplierAllocations: decision.allSupplierAllocations,
    });

    // 5. Emit PO created
    emit({
      type: "po_created",
      purchaseOrderId: decision.purchaseOrderId,
      status: "draft",
    });

    emit({ type: "complete" });

    console.log(
      `\n=== CURVEBALL PIPELINE COMPLETE: PO ${decision.purchaseOrderId} ===\n`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Curveball pipeline failed";
    console.error(
      `curveball: Error in pipeline for ${negotiationId}:`,
      error,
    );

    if (!clientDisconnected) {
      emit({ type: "error", message });
    }
  }

  if (!clientDisconnected) {
    res.end();
  }
});
