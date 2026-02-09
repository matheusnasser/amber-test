// Load env FIRST — must be the first import so API keys are available to all modules
import "./lib/env";

import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth";
import { parseRouter } from "./routes/parse";
import { negotiateRouter } from "./routes/negotiate";
import { curveballRouter } from "./routes/curveball";
import { purchaseOrderRouter } from "./routes/purchase-orders";
import { authenticateToken } from "./middleware/auth";

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

// Public routes (no authentication required)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/auth", authRouter);

// Protected routes (authentication required)
app.use("/api/parse", authenticateToken, parseRouter);
app.use("/api/negotiate", authenticateToken, negotiateRouter);
app.use("/api/curveball", authenticateToken, curveballRouter);
app.use("/api/purchase-orders", authenticateToken, purchaseOrderRouter);

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});
