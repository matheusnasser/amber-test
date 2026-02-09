-- CreateTable
CREATE TABLE "NegotiationEvent" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "sequenceNum" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventData" JSONB NOT NULL,
    "timestamp" BIGINT NOT NULL,

    CONSTRAINT "NegotiationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NegotiationEvent_negotiationId_sequenceNum_idx" ON "NegotiationEvent"("negotiationId", "sequenceNum");

-- AddForeignKey
ALTER TABLE "NegotiationEvent" ADD CONSTRAINT "NegotiationEvent_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "Negotiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
