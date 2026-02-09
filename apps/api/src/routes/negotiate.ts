import { Router } from "express";
import { prisma } from "@supplier-negotiation/database";
import { runNegotiation, runPostCurveballRounds } from "../agents/negotiation-loop";
import { generateFinalDecision, analyzeCurveball } from "../agents/decision-maker";
import {
  emitNegotiationEvent,
  subscribeToNegotiation,
} from "../lib/event-bus";
import type { OfferData } from "../agents/types";

export const negotiateRouter = Router();

// POST /api/negotiate — Start a negotiation, stream events via SSE
negotiateRouter.post("/", async (req, res) => {
  const { quotationId, userNotes, mode, maxRounds } = req.body as {
    quotationId?: string;
    userNotes?: string;
    mode?: string;
    maxRounds?: number;
  };

  if (!quotationId) {
    res.status(400).json({ error: "quotationId is required" });
    return;
  }

  // Verify quotation exists
  const quotation = await prisma.quotation.findUnique({
    where: { id: quotationId },
  });

  if (!quotation) {
    res.status(404).json({ error: "Quotation not found" });
    return;
  }

  // Check if a completed negotiation already exists for this quotation
  const existing = await prisma.negotiation.findUnique({
    where: { quotationId },
    include: {
      rounds: { select: { id: true } },
      purchaseOrder: {
        select: {
          id: true,
          reasoning: true,
          comparisonData: true,
          allocations: {
            select: {
              id: true,
              supplierId: true,
              allocationPct: true,
              agreedCost: true,
              agreedLeadTimeDays: true,
              agreedPaymentTerms: true,
              fobCost: true,
              cashFlowCost: true,
              effectiveLandedCost: true,
              supplier: { select: { id: true, name: true } },
              items: {
                select: {
                  id: true,
                  productId: true,
                  quantity: true,
                  agreedUnitPrice: true,
                  agreedTotalPrice: true,
                  product: { select: { sku: true, name: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  // If negotiation is completed with a PO, return stored decision instead of restarting
  if (existing && existing.status === "completed" && existing.purchaseOrder) {
    console.log(`negotiate: Returning existing completed negotiation ${existing.id} for quotation ${quotationId}`);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Read decision data from PO's comparisonData (stores full decision payload)
    const storedData = (existing.purchaseOrder.comparisonData as Record<string, unknown>) ?? null;

    // Reconstruct decision from stored PO + stored event data
    const po = existing.purchaseOrder;
    const allocations = po.allocations.map((a) => ({
      supplierId: a.supplierId,
      supplierName: a.supplier.name,
      allocationPct: a.allocationPct,
      agreedCost: a.agreedCost,
      leadTimeDays: a.agreedLeadTimeDays,
      paymentTerms: a.agreedPaymentTerms,
      items: a.items.map((i) => ({
        sku: i.product.sku,
        description: i.product.name,
        quantity: i.quantity,
        unitPrice: i.agreedUnitPrice,
        totalPrice: i.agreedTotalPrice,
      })),
    }));

    const primary = allocations.reduce((a, b) => a.allocationPct > b.allocationPct ? a : b, allocations[0]);

    const decisionEvent = {
      type: "decision",
      recommendation: storedData?.recommendation ?? {
        primarySupplierId: primary.supplierId,
        primarySupplierName: primary.supplierName,
        splitOrder: allocations.length > 1,
        allocations,
      },
      comparison: storedData?.comparison ?? (po.comparisonData as unknown[]) ?? [],
      summary: storedData?.summary ?? "",
      keyPoints: storedData?.keyPoints ?? [],
      reasoning: storedData?.reasoning ?? po.reasoning,
      tradeoffs: storedData?.tradeoffs ?? "",
      purchaseOrderId: po.id,
      allSupplierAllocations: storedData?.allSupplierAllocations ?? allocations,
      timestamp: Date.now(),
    };

    res.write(`data: ${JSON.stringify({ type: "negotiation_started", negotiationId: existing.id, timestamp: Date.now() })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "negotiation_complete", negotiationId: existing.id, timestamp: Date.now() })}\n\n`);
    res.write(`data: ${JSON.stringify(decisionEvent)}\n\n`);
    res.end();
    return;
  }

  // If negotiation is currently running, subscribe to existing stream instead of restarting
  if (existing && (existing.status === "negotiating" || existing.status === "curveball")) {
    console.log(`negotiate: Negotiation ${existing.id} already in-progress (${existing.status}), subscribing to stream`);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send the negotiation ID so the frontend can track it
    res.write(`data: ${JSON.stringify({ type: "negotiation_started", negotiationId: existing.id, timestamp: Date.now() })}\n\n`);

    // Determine which supplier is the XLSX source (non-simulated)
    const quotationWithSupplier = await prisma.quotation.findUnique({
      where: { id: quotationId },
      select: { supplier: { select: { id: true, code: true } } },
    });
    const xlsxSourceId = quotationWithSupplier?.supplier?.id ?? null;

    // Replay existing rounds as messages
    const existingRounds = await prisma.negotiationRound.findMany({
      where: { negotiationId: existing.id },
      orderBy: [{ roundNumber: "asc" }, { createdAt: "asc" }],
      include: {
        supplier: { select: { id: true, name: true, code: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });

    // Emit supplier_started for each unique supplier (with correct isSimulated flag)
    const seenSuppliers = new Set<string>();
    for (const round of existingRounds) {
      if (!seenSuppliers.has(round.supplierId)) {
        seenSuppliers.add(round.supplierId);
        const isSimulated = round.supplier.id !== xlsxSourceId;
        res.write(`data: ${JSON.stringify({
          type: "supplier_started",
          supplierId: round.supplier.id,
          supplierName: round.supplier.name,
          supplierCode: round.supplier.code,
          isSimulated,
          timestamp: Date.now(),
        })}\n\n`);
      }
    }

    // Replay messages and offers from existing rounds
    for (const round of existingRounds) {
      for (const msg of round.messages) {
        res.write(`data: ${JSON.stringify({
          type: "message",
          role: msg.role,
          supplierId: round.supplierId,
          supplierName: round.supplier.name,
          content: msg.content,
          roundNumber: round.roundNumber,
          messageId: msg.id,
          timestamp: Date.now(),
        })}\n\n`);
      }
      if (round.offerData) {
        res.write(`data: ${JSON.stringify({
          type: "offer_extracted",
          supplierId: round.supplierId,
          roundNumber: round.roundNumber,
          offer: round.offerData,
          timestamp: Date.now(),
        })}\n\n`);
      }
    }

    // Subscribe to live events for the rest of the negotiation
    const unsubscribe = subscribeToNegotiation(existing.id, (event) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });

    req.on("close", () => {
      unsubscribe();
      console.log(`negotiate: Reconnected client disconnected for ${existing.id}`);
    });

    return;
  }

  // If a failed/stale negotiation exists (not running, not completed), delete and start fresh
  if (existing) {
    console.log(`negotiate: Deleting stale negotiation ${existing.id} (status: ${existing.status}) for quotation ${quotationId}`);

    if (existing.purchaseOrder) {
      const allocationIds = existing.purchaseOrder.allocations.map((a) => a.id);
      if (allocationIds.length > 0) {
        await prisma.purchaseOrderItem.deleteMany({ where: { allocationId: { in: allocationIds } } });
        await prisma.purchaseOrderAllocation.deleteMany({ where: { purchaseOrderId: existing.purchaseOrder.id } });
      }
      await prisma.purchaseOrder.delete({ where: { id: existing.purchaseOrder.id } });
    }

    const roundIds = existing.rounds.map((r) => r.id);
    if (roundIds.length > 0) {
      await prisma.message.deleteMany({ where: { roundId: { in: roundIds } } });
      await prisma.negotiationRound.deleteMany({ where: { negotiationId: existing.id } });
    }

    await prisma.negotiation.delete({ where: { id: existing.id } });
    console.log(`negotiate: Deleted stale negotiation ${existing.id}`);
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const totalMaxRounds = maxRounds && maxRounds >= 1 && maxRounds <= 5 ? maxRounds : 4;

  // Create Negotiation in DB
  const negotiation = await prisma.negotiation.create({
    data: {
      organizationId: quotation.organizationId,
      quotationId,
      userNotes: userNotes ?? null,
      mode: mode ?? "balanced",
      maxRounds: totalMaxRounds,
      status: "negotiating",
    },
  });

  console.log(
    `negotiate: Created negotiation ${negotiation.id} for quotation ${quotationId}`,
  );

  // Handle client disconnect
  let clientDisconnected = false;
  req.on("close", () => {
    clientDisconnected = true;
    console.log(`negotiate: Client disconnected for ${negotiation.id}`);
  });

  const persistAndEmit = (event: Record<string, unknown>) => {
    emitNegotiationEvent(negotiation.id, event);
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  // Run the negotiation loop with SSE streaming
  // Flow: 1 initial round → curveball banner → remaining post-curveball rounds → final decision
  try {
    // ── Phase 1: Run 1 initial round to get opening offers ──
    await runNegotiation({
      negotiationId: negotiation.id,
      quotationId,
      userNotes: userNotes ?? "",
      mode: mode ?? "balanced",
      maxRounds: 1,
      onEvent: (event) => {
        persistAndEmit(event as Record<string, unknown>);
      },
    });

    // ── Phase 2: Curveball — SUP-002 capacity constraint ──
    console.log(`negotiate: Injecting curveball after round 1 for ${negotiation.id}...`);

    const affectedSupplier = await prisma.supplier.findFirst({
      where: { organizationId: quotation.organizationId, code: "SUP-002" },
    });

    if (affectedSupplier) {
      const curveballDescription = `${affectedSupplier.name} (SUP-002) can only fulfill 60% of the order due to material shortage`;

      // Find SUP-002's latest round after Round 1
      const sup2Round = await prisma.negotiationRound.findFirst({
        where: {
          negotiationId: negotiation.id,
          supplierId: affectedSupplier.id
        },
        orderBy: { roundNumber: 'desc' },
      });

      if (sup2Round) {
        // Create natural message from S2's agent about capacity constraint
        const capacityMessage = "I need to be transparent with you — our production team just flagged a material availability issue. We can confidently commit to 60% of this order volume while maintaining our quality standards, but the full quantity would risk delays. I'd like to discuss how we can restructure this to meet your timeline. Can we explore splitting the order or adjusting quantities?";

        await prisma.message.create({
          data: {
            roundId: sup2Round.id,
            role: "supplier_agent",
            content: capacityMessage,
          },
        });

        // Emit this as a regular message event (supplier naturally reveals constraint)
        persistAndEmit({
          type: "message",
          role: "supplier_agent",
          content: capacityMessage,
          supplierName: affectedSupplier.name,
          supplierId: affectedSupplier.id,
          roundNumber: 1,
        });
      }

      // Update negotiation status
      await prisma.negotiation.update({
        where: { id: negotiation.id },
        data: { status: "curveball", curveballDesc: curveballDescription },
      });

      // Analyze curveball impact
      const curveballAnalysis = await analyzeCurveball(
        negotiation.id,
        affectedSupplier.id,
        curveballDescription,
      ).catch((err) => {
        console.warn("negotiate: Curveball analysis failed, proceeding without:", err);
        return undefined;
      });

      // Emit curveball_analysis so frontend can show strategies in the banner
      if (curveballAnalysis) {
        persistAndEmit({
          type: "curveball_analysis",
          analysis: curveballAnalysis,
          timestamp: Date.now(),
        });
      }

      // ── Phase 3: Post-curveball rounds (remaining budget) ──
      const postCurveballRounds = Math.max(1, totalMaxRounds - 1);
      console.log(`negotiate: Running ${postCurveballRounds} post-curveball rounds for ${negotiation.id}...`);

      await runPostCurveballRounds({
        negotiationId: negotiation.id,
        curveballDescription,
        affectedSupplierId: affectedSupplier.id,
        curveballAnalysis,
        maxRounds: postCurveballRounds,
        onEvent: (event) => {
          persistAndEmit(event as Record<string, unknown>);
        },
      });
    }

    // ── Phase 4: Generate final decision ──
    console.log(`negotiate: Generating final decision for ${negotiation.id}...`);
    persistAndEmit({ type: "generating_decision", negotiationId: negotiation.id, timestamp: Date.now() });
    const decision = await generateFinalDecision(negotiation.id);

    const decisionEvent = {
      type: "decision",
      recommendation: decision.recommendation,
      comparison: decision.comparison,
      summary: decision.summary,
      keyPoints: decision.keyPoints,
      reasoning: decision.reasoning,
      tradeoffs: decision.tradeoffs,
      purchaseOrderId: decision.purchaseOrderId,
      allSupplierAllocations: decision.allSupplierAllocations,
      timestamp: Date.now(),
    };
    persistAndEmit(decisionEvent);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Negotiation failed";
    console.error(`negotiate: Error in negotiation ${negotiation.id}:`, error);

    if (!clientDisconnected) {
      res.write(
        `data: ${JSON.stringify({ type: "error", message })}\n\n`,
      );
    }

    // Mark negotiation as failed
    await prisma.negotiation.update({
      where: { id: negotiation.id },
      data: { status: "completed" },
    }).catch(() => {});
  }

  if (!clientDisconnected) {
    res.end();
  }
});

// POST /api/negotiate/requote — Re-quote with adjusted quantities and selected suppliers
// Preserves prior negotiation history, replays it to the client, then runs new rounds
negotiateRouter.post("/requote", async (req, res) => {
  const { quotationId, supplierIds, qtyChanges, userNotes, mode, maxRounds } = req.body as {
    quotationId?: string;
    supplierIds?: string[];
    qtyChanges?: Record<string, { from: number; to: number }>;
    userNotes?: string;
    mode?: string;
    maxRounds?: number;
  };

  if (!quotationId) {
    res.status(400).json({ error: "quotationId is required" });
    return;
  }
  if (!supplierIds || supplierIds.length === 0) {
    res.status(400).json({ error: "At least one supplier must be selected" });
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

  // 1. Load prior negotiation with full history (rounds, messages, offers)
  const priorOffers: Record<string, OfferData> = {};
  const existing = await prisma.negotiation.findUnique({
    where: { quotationId },
    include: {
      rounds: {
        include: { messages: { orderBy: { createdAt: "asc" } } },
        orderBy: [{ supplierId: "asc" }, { roundNumber: "asc" }],
      },
      purchaseOrder: {
        select: {
          id: true,
          reasoning: true,
          totalCost: true,
          allocations: {
            select: {
              supplierId: true,
              allocationPct: true,
              agreedCost: true,
              agreedLeadTimeDays: true,
              agreedPaymentTerms: true,
              supplier: { select: { name: true, code: true } },
            },
          },
        },
      },
    },
  });

  // Build prior context from the existing negotiation
  let priorContext = "";
  const priorConversations: Record<string, Array<{ role: string; content: string }>> = {};

  if (existing) {
    const contextLines: string[] = [
      "RE-QUOTE CONTEXT — This is a follow-up to a prior negotiation. The buyer is requesting specific changes to the order.",
    ];

    // Extract prior offers and conversation history per supplier
    const seenSuppliers = new Set<string>();
    for (const round of existing.rounds) {
      // Capture latest offer per supplier
      if (!seenSuppliers.has(round.supplierId)) {
        seenSuppliers.add(round.supplierId);
        // Find the latest round for this supplier (rounds are sorted asc, so iterate all)
      }
      const raw = round.offerData as Record<string, unknown> | null;
      if (raw && typeof raw.totalCost === "number") {
        priorOffers[round.supplierId] = {
          totalCost: raw.totalCost as number,
          items: (Array.isArray(raw.items) ? raw.items : []) as OfferData["items"],
          leadTimeDays: (raw.leadTimeDays as number) ?? 30,
          paymentTerms: (raw.paymentTerms as string) ?? "50/50",
          concessions: (raw.concessions as string[]) ?? [],
          conditions: (raw.conditions as string[]) ?? [],
        };
      }
      // Capture conversation history per supplier
      if (!priorConversations[round.supplierId]) priorConversations[round.supplierId] = [];
      for (const msg of round.messages) {
        priorConversations[round.supplierId].push({ role: msg.role, content: msg.content });
      }
    }

    // Build context summary
    for (const [suppId, offer] of Object.entries(priorOffers)) {
      const supplierRounds = existing.rounds.filter((r) => r.supplierId === suppId);
      const supplierName = supplierRounds[0]?.messages?.[0]?.role === "brand_agent" ? suppId : suppId;
      contextLines.push(
        `- Supplier ${suppId}: $${offer.totalCost.toLocaleString()} total, ${offer.leadTimeDays}d lead, ${offer.paymentTerms} terms, ${offer.concessions.length} concessions`,
      );
    }

    if (existing.purchaseOrder) {
      const po = existing.purchaseOrder;
      contextLines.push(`\nPrior decision: Total $${po.totalCost.toLocaleString()}`);
      for (const alloc of po.allocations) {
        contextLines.push(
          `  - ${alloc.supplier.name}: ${alloc.allocationPct}% allocation, $${alloc.agreedCost.toLocaleString()}, ${alloc.agreedLeadTimeDays}d lead, ${alloc.agreedPaymentTerms} terms`,
        );
      }
    }

    // Add qty changes summary
    if (qtyChanges && Object.keys(qtyChanges).length > 0) {
      contextLines.push("\nQUANTITY CHANGES REQUESTED:");
      for (const [sku, change] of Object.entries(qtyChanges)) {
        contextLines.push(`  - ${sku}: ${change.from} → ${change.to} units`);
      }
      contextLines.push("Focus negotiation on the price impact of these specific changes. Other items stay at prior agreed pricing unless the supplier proposes adjustments.");
    }

    priorContext = contextLines.join("\n");
    console.log(`requote: Captured ${Object.keys(priorOffers).length} prior offers, ${Object.keys(priorConversations).length} conversation histories`);

    // Delete old PO (will be regenerated) but keep the negotiation for now
    if (existing.purchaseOrder) {
      await prisma.purchaseOrderItem.deleteMany({ where: { allocation: { purchaseOrderId: existing.purchaseOrder.id } } });
      await prisma.purchaseOrderAllocation.deleteMany({ where: { purchaseOrderId: existing.purchaseOrder.id } });
      await prisma.purchaseOrder.delete({ where: { id: existing.purchaseOrder.id } });
    }
    // Delete old rounds + messages — we'll replay history then run fresh rounds
    const roundIds = existing.rounds.map((r) => r.id);
    if (roundIds.length > 0) {
      await prisma.message.deleteMany({ where: { roundId: { in: roundIds } } });
      await prisma.negotiationRound.deleteMany({ where: { negotiationId: existing.id } });
    }
    await prisma.negotiation.delete({ where: { id: existing.id } });
  }

  // 2. Apply quantity changes to quotation items
  if (qtyChanges && Object.keys(qtyChanges).length > 0) {
    for (const [sku, change] of Object.entries(qtyChanges)) {
      const newQty = change.to;
      const matchingItems = quotation.items.filter(
        (i) => i.rawSku.toUpperCase().trim() === sku.toUpperCase().trim(),
      );
      for (const item of matchingItems) {
        const newTotal = Math.round(newQty * item.unitPrice * 100) / 100;
        await prisma.quotationItem.update({
          where: { id: item.id },
          data: {
            quantity: newQty,
            rawQuantity: String(newQty),
            totalPrice: newTotal,
          },
        });
      }
    }
    console.log(`requote: Updated ${Object.keys(qtyChanges).length} SKU quantities`);
  }

  // 3. Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Re-quote: 3 rounds max with full pillar analysis
  const totalMaxRounds = Math.min(maxRounds ?? 3, 3);

  // 4. Build user notes with prior context + qty change focus
  const effectiveNotes = [
    userNotes ?? quotation.notes ?? "",
    priorContext,
  ].filter(Boolean).join("\n\n");

  // 5. Create new Negotiation
  const negotiation = await prisma.negotiation.create({
    data: {
      organizationId: quotation.organizationId,
      quotationId,
      userNotes: effectiveNotes || null,
      mode: mode ?? "balanced",
      maxRounds: totalMaxRounds,
      status: "negotiating",
    },
  });

  console.log(`requote: Created negotiation ${negotiation.id} for quotation ${quotationId} with ${supplierIds.length} suppliers, ${totalMaxRounds} rounds`);

  let clientDisconnected = false;
  req.on("close", () => {
    clientDisconnected = true;
    console.log(`requote: Client disconnected for ${negotiation.id}`);
  });

  const persistAndEmit = (event: Record<string, unknown>) => {
    emitNegotiationEvent(negotiation.id, event);
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  // 6. Replay prior conversation history to frontend so user sees the chat context
  persistAndEmit({ type: "negotiation_started", negotiationId: negotiation.id, timestamp: Date.now() });

  // Load supplier info for replay
  const allSuppliers = await prisma.supplier.findMany({ where: { id: { in: supplierIds } } });
  const sourceSupId = quotation.supplierId;

  for (const supplier of allSuppliers) {
    const isSimulated = supplier.id !== sourceSupId;
    persistAndEmit({
      type: "supplier_started",
      supplierId: supplier.id,
      supplierName: supplier.name,
      supplierCode: supplier.code,
      isSimulated,
      timestamp: Date.now(),
    });

    // Replay prior messages for this supplier
    const priorMsgs = priorConversations[supplier.id] ?? [];
    let roundNum = 1;
    let msgCount = 0;
    for (const msg of priorMsgs) {
      // Estimate round from message pairs (brand + supplier = 1 round)
      if (msg.role === "brand_agent" && msgCount > 0 && msgCount % 2 === 0) roundNum++;
      persistAndEmit({
        type: "message",
        role: msg.role,
        supplierId: supplier.id,
        supplierName: supplier.name,
        content: msg.content,
        roundNumber: roundNum,
        phase: "initial",
        messageId: `replay-${supplier.id}-${msgCount}`,
        timestamp: Date.now(),
      });
      msgCount++;
    }

    // Replay latest offer
    const latestOffer = priorOffers[supplier.id];
    if (latestOffer) {
      persistAndEmit({
        type: "offer_extracted",
        supplierId: supplier.id,
        roundNumber: roundNum,
        offer: latestOffer,
        timestamp: Date.now(),
      });
    }
  }

  // Emit re-quote phase divider
  for (const supplier of allSuppliers) {
    persistAndEmit({
      type: "message",
      role: "brand_agent" as string,
      supplierId: supplier.id,
      supplierName: supplier.name,
      content: `--- RE-QUOTE: Order quantities updated. ${Object.keys(qtyChanges ?? {}).length} SKU(s) changed. Requesting updated pricing. ---`,
      roundNumber: 0,
      phase: "post_curveball",
      messageId: `requote-divider-${supplier.id}`,
      timestamp: Date.now(),
    });
  }

  try {
    // 7. Run re-quote negotiation with full pillar analysis
    // Prior offers seeded for context; qtyChanges injected into brand agent prompts
    await runNegotiation({
      negotiationId: negotiation.id,
      quotationId,
      userNotes: effectiveNotes,
      mode: mode ?? "balanced",
      maxRounds: totalMaxRounds,
      supplierIds,
      priorOffers: Object.keys(priorOffers).length > 0 ? priorOffers : undefined,
      isReQuote: true,
      qtyChanges: qtyChanges ?? undefined,
      onEvent: (event) => {
        persistAndEmit(event as Record<string, unknown>);
      },
    });

    // 8. Generate final decision
    console.log(`requote: Generating final decision for ${negotiation.id}...`);
    persistAndEmit({ type: "generating_decision", negotiationId: negotiation.id, timestamp: Date.now() });
    const decision = await generateFinalDecision(negotiation.id);

    persistAndEmit({
      type: "decision",
      recommendation: decision.recommendation,
      comparison: decision.comparison,
      summary: decision.summary,
      keyPoints: decision.keyPoints,
      reasoning: decision.reasoning,
      tradeoffs: decision.tradeoffs,
      purchaseOrderId: decision.purchaseOrderId,
      allSupplierAllocations: decision.allSupplierAllocations,
      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Re-quote negotiation failed";
    console.error(`requote: Error in negotiation ${negotiation.id}:`, error);

    if (!clientDisconnected) {
      persistAndEmit({ type: "error", message, timestamp: Date.now() });
    }

    await prisma.negotiation.update({
      where: { id: negotiation.id },
      data: { status: "completed" },
    }).catch(() => {});
  }

  if (!clientDisconnected) {
    res.end();
  }
});

// GET /api/negotiate/:negotiationId — Load negotiation state from DB
negotiateRouter.get("/:negotiationId", async (req, res) => {
  const { negotiationId } = req.params;

  const negotiation = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    include: {
      quotation: {
        select: {
          supplier: { select: { code: true } },
          parseMetadata: true,
        },
      },
      rounds: {
        orderBy: [
          { supplierId: "asc" },
          { roundNumber: "asc" },
        ],
        include: {
          supplier: {
            select: {
              id: true,
              name: true,
              code: true,
              qualityRating: true,
              priceLevel: true,
              leadTimeDays: true,
              paymentTerms: true,
            },
          },
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });

  if (!negotiation) {
    res.status(404).json({ error: "Negotiation not found" });
    return;
  }

  const xlsxSourceCode = negotiation.quotation?.supplier?.code ?? "SUP-001";

  // Group rounds by supplier
  const supplierMap = new Map<
    string,
    {
      supplierId: string;
      supplierName: string;
      supplierCode: string;
      rounds: Array<{
        roundNumber: number;
        phase: string;
        offerData: unknown;
        status: string;
        messages: Array<{
          id: string;
          role: string;
          content: string;
          createdAt: Date;
        }>;
      }>;
    }
  >();

  for (const round of negotiation.rounds) {
    const key = round.supplierId;
    if (!supplierMap.has(key)) {
      supplierMap.set(key, {
        supplierId: round.supplier.id,
        supplierName: round.supplier.name,
        supplierCode: round.supplier.code,
        rounds: [],
      });
    }
    supplierMap.get(key)!.rounds.push({
      roundNumber: round.roundNumber,
      phase: round.phase,
      offerData: round.offerData,
      status: round.status,
      messages: round.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  }

  // Sort suppliers: XLSX source first, then by code
  const suppliers = Array.from(supplierMap.values()).sort((a, b) => {
    if (a.supplierCode === xlsxSourceCode) return -1;
    if (b.supplierCode === xlsxSourceCode) return 1;
    return a.supplierCode.localeCompare(b.supplierCode);
  });

  res.json({
    negotiationId: negotiation.id,
    quotationId: negotiation.quotationId,
    status: negotiation.status,
    mode: negotiation.mode,
    userNotes: negotiation.userNotes,
    suppliers,
    totalTokens: negotiation.totalTokens,
    totalCostUsd: negotiation.totalCostUsd,
    parseMetadata: negotiation.quotation?.parseMetadata ?? null,
  });
});

// GET /api/negotiate/:negotiationId/stream — SSE subscription for real-time orchestration events
negotiateRouter.get("/:negotiationId/stream", async (req, res) => {
  const { negotiationId } = req.params;

  // Authentication: Accept token from Authorization header or query param (for EventSource)
  const authHeader = req.headers["authorization"];
  const token = authHeader?.split(" ")[1] || (req.query.token as string | undefined);

  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  const { verifyToken } = await import("../lib/auth");
  const decoded = verifyToken(token);
  if (!decoded) {
    res.status(403).json({ error: "Invalid or expired token" });
    return;
  }

  // Verify negotiation exists
  const negotiation = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    select: { id: true, status: true },
  });

  if (!negotiation) {
    res.status(404).json({ error: "Negotiation not found" });
    return;
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Send initial status
  res.write(
    `data: ${JSON.stringify({ type: "connected", negotiationId, status: negotiation.status })}\n\n`,
  );

  // If already completed, send done immediately
  if (negotiation.status === "completed") {
    res.write(
      `data: ${JSON.stringify({ type: "negotiation_complete", negotiationId })}\n\n`,
    );
    res.end();
    return;
  }

  // Subscribe to real-time events
  const unsubscribe = subscribeToNegotiation(negotiationId, (event) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  // Clean up on disconnect
  req.on("close", () => {
    unsubscribe();
    console.log(`negotiate: SSE subscriber disconnected for ${negotiationId}`);
  });
});

// GET /api/negotiate/:negotiationId/decision — Reconstruct stored decision from DB
negotiateRouter.get("/:negotiationId/decision", async (req, res) => {
  const { negotiationId } = req.params;

  const negotiation = await prisma.negotiation.findUnique({
    where: { id: negotiationId },
    select: {
      id: true,
      status: true,
      purchaseOrder: {
        select: {
          id: true,
          reasoning: true,
          comparisonData: true,
          allocations: {
            select: {
              supplierId: true,
              allocationPct: true,
              agreedCost: true,
              agreedLeadTimeDays: true,
              agreedPaymentTerms: true,
              supplier: { select: { id: true, name: true } },
              items: {
                select: {
                  productId: true,
                  quantity: true,
                  agreedUnitPrice: true,
                  agreedTotalPrice: true,
                  product: { select: { sku: true, name: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!negotiation || negotiation.status !== "completed" || !negotiation.purchaseOrder) {
    res.status(404).json({ error: "No completed decision found" });
    return;
  }

  // Read decision data from PO's comparisonData (stores full decision payload)
  const storedData = (negotiation.purchaseOrder.comparisonData as Record<string, unknown>) ?? null;

  const po = negotiation.purchaseOrder;
  const allocations = po.allocations.map((a) => ({
    supplierId: a.supplierId,
    supplierName: a.supplier.name,
    allocationPct: a.allocationPct,
    agreedCost: a.agreedCost,
    leadTimeDays: a.agreedLeadTimeDays,
    paymentTerms: a.agreedPaymentTerms,
    items: a.items.map((i) => ({
      sku: i.product.sku,
      description: i.product.name,
      quantity: i.quantity,
      unitPrice: i.agreedUnitPrice,
      totalPrice: i.agreedTotalPrice,
    })),
  }));

  const primary = allocations.reduce((a, b) => a.allocationPct > b.allocationPct ? a : b, allocations[0]);

  res.json({
    recommendation: storedData?.recommendation ?? {
      primarySupplierId: primary.supplierId,
      primarySupplierName: primary.supplierName,
      splitOrder: allocations.length > 1,
      allocations,
    },
    comparison: storedData?.comparison ?? (po.comparisonData as unknown[]) ?? [],
    summary: storedData?.summary ?? "",
    keyPoints: storedData?.keyPoints ?? [],
    reasoning: storedData?.reasoning ?? po.reasoning,
    tradeoffs: storedData?.tradeoffs ?? "",
    purchaseOrderId: po.id,
    allSupplierAllocations: storedData?.allSupplierAllocations ?? allocations,
  });
});

// GET /api/negotiate/by-quotation/:quotationId — Find negotiation by quotation
negotiateRouter.get("/by-quotation/:quotationId", async (req, res) => {
  const { quotationId } = req.params;

  const negotiation = await prisma.negotiation.findUnique({
    where: { quotationId },
    select: { id: true, status: true },
  });

  if (!negotiation) {
    res.status(404).json({ error: "No negotiation found for this quotation" });
    return;
  }

  res.json(negotiation);
});
