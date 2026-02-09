import { Router } from "express";
import { prisma } from "@supplier-negotiation/database";

export const purchaseOrderRouter = Router();

// POST /api/purchase-orders/:id/confirm
purchaseOrderRouter.post("/:id/confirm", async (req, res) => {
  const { id } = req.params;

  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id },
  });

  if (!purchaseOrder) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  if (purchaseOrder.status !== "draft") {
    res.status(400).json({
      error: `Cannot confirm PO in "${purchaseOrder.status}" status. Only "draft" POs can be confirmed.`,
    });
    return;
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id },
    data: { status: "confirmed" },
  });

  console.log(`purchase-orders: Confirmed PO ${id}`);

  res.json({
    purchaseOrderId: updated.id,
    status: updated.status,
  });
});
