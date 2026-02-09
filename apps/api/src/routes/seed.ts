import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { resolve } from "path";

const router = Router();
const prisma = new PrismaClient();

function parseSku(sku: string): {
  skuPrefix: string;
  colorCode: string;
  sizeCode: string;
} {
  const parts = sku.split("-");
  return {
    skuPrefix: parts[0] || "",
    colorCode: parts[1] || "",
    sizeCode: parts.slice(2).join("-") || "",
  };
}

router.post("/", async (_req, res) => {
  try {
    // 1. Create demo organization
    const org = await prisma.organization.upsert({
      where: { id: "org-demo" },
      update: { name: "Valden Outdoor" },
      create: {
        id: "org-demo",
        name: "Valden Outdoor",
      },
    });

    // 2. Create simulated negotiation suppliers
    const simulatedSuppliers = [
      {
        id: "supplier-2",
        organizationId: org.id,
        name: "Alpine Premium",
        code: "SUP-002",
        qualityRating: 4.7,
        priceLevel: "expensive",
        leadTimeDays: 25,
        paymentTerms: "40/60",
        isSimulated: true,
      },
      {
        id: "supplier-3",
        organizationId: org.id,
        name: "RapidGear Co",
        code: "SUP-003",
        qualityRating: 4.0,
        priceLevel: "mid",
        leadTimeDays: 15,
        paymentTerms: "100",
        isSimulated: true,
      },
    ];

    for (const supplier of simulatedSuppliers) {
      await prisma.supplier.upsert({
        where: {
          organizationId_code: {
            organizationId: supplier.organizationId,
            code: supplier.code,
          },
        },
        update: supplier,
        create: supplier,
      });
    }

    // 3. Import products from CSV
    // In Docker: /app/data/products.csv
    // Locally: ../../data/products.csv (relative to apps/api)
    const csvPaths = [
      resolve("/app/data/products.csv"),
      resolve(__dirname, "../../../../data/products.csv"),
      resolve(process.cwd(), "data/products.csv"),
    ];

    let csvContent = "";
    for (const p of csvPaths) {
      try {
        csvContent = readFileSync(p, "utf-8").replace(/\r/g, "");
        break;
      } catch {
        continue;
      }
    }

    if (!csvContent) {
      return res.json({
        success: true,
        message: "Org and suppliers seeded, but products.csv not found — skipping products.",
        org: org.name,
        suppliers: simulatedSuppliers.length,
        products: 0,
      });
    }

    const lines = csvContent.trim().split("\n");
    const header = lines[0].split(",");

    const brandIdx = header.indexOf("brand");
    const skuIdx = header.indexOf("sku");
    const nameIdx = header.indexOf("name");
    const colorIdx = header.indexOf("color");

    const products = lines
      .slice(1)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const cols = line.split(",");
        const sku = (cols[skuIdx] || "").trim();
        const { skuPrefix, colorCode, sizeCode } = parseSku(sku);

        return {
          brand: (cols[brandIdx] || "").trim(),
          sku,
          name: (cols[nameIdx] || "").trim(),
          color: (cols[colorIdx] || "").trim(),
          skuPrefix,
          colorCode,
          sizeCode,
        };
      });

    // Wipe existing products (and dependents)
    await prisma.purchaseOrderItem.deleteMany();
    await prisma.quotationItem.deleteMany();
    await prisma.product.deleteMany();

    // Batch insert
    const batchSize = 500;
    let imported = 0;
    for (let i = 0; i < products.length; i += batchSize) {
      const batch = products.slice(i, i + batchSize);
      await prisma.product.createMany({ data: batch });
      imported += batch.length;
    }

    res.json({
      success: true,
      message: "Seeding complete",
      org: org.name,
      suppliers: simulatedSuppliers.length,
      products: imported,
    });
  } catch (error: any) {
    console.error("Seed error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export { router as seedRouter };
