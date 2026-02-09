import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import { resolve } from "path";

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

async function main() {
  console.log("Seeding database...");

  // 1. Create demo organization
  const org = await prisma.organization.upsert({
    where: { id: "org-demo" },
    update: { name: "Valden Outdoor" },
    create: {
      id: "org-demo",
      name: "Valden Outdoor",
    },
  });
  console.log(`Organization: ${org.name}`);

  // 2. Create simulated negotiation suppliers (SUP-002, SUP-003)
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
  console.log(
    `Suppliers: ${simulatedSuppliers.length} simulated agents created`,
  );

  // 3. Import products from CSV
  const csvPath = resolve(__dirname, "../../../data/products.csv");
  const csvContent = readFileSync(csvPath, "utf-8").replace(/\r/g, "");
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

  // Wipe existing products (and dependents) so re-seed picks up all columns
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.quotationItem.deleteMany();
  await prisma.product.deleteMany();

  // Batch insert products
  const batchSize = 500;
  let imported = 0;
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    await prisma.product.createMany({
      data: batch,
    });
    imported += batch.length;
    process.stdout.write(`\rProducts: ${imported}/${products.length} imported`);
  }
  console.log(`\nProducts: ${products.length} total`);

  console.log("Seeding complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
