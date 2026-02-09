// Agent-specific types that mirror Prisma models but are decoupled for agent functions.

export interface SupplierProfile {
  id: string;
  name: string;
  code: string;
  qualityRating: number;
  priceLevel: string; // "cheapest" | "mid" | "expensive"
  leadTimeDays: number;
  paymentTerms: string; // "33/33/33" | "40/60" | "100"
  isSimulated: boolean;
}

export interface PricingTierData {
  quantity: number;
  unitPrice: number;
  totalPrice: number;
}

export interface QuotationItemData {
  rawSku: string;
  rawDescription: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  rawNotes?: string | null; // notes, discounts, conditions from XLSX
  tiers?: PricingTierData[]; // all pricing tiers if multi-tier quotation
}

export interface VolumeTier {
  minQty: number;
  maxQty: number | null; // null = no upper limit
  unitPrice: number;
}

export interface OfferItem {
  sku: string;
  unitPrice: number;
  quantity: number;
  volumeTiers?: VolumeTier[];
}

export interface OfferData {
  totalCost: number;
  items: OfferItem[];
  leadTimeDays: number;
  paymentTerms: string;
  concessions: string[];
  conditions: string[];
}

export interface MessageData {
  role: "brand_agent" | "supplier_agent";
  content: string;
}
