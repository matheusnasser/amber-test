/*
  Warnings:

  - You are about to drop the `NegotiationEvent` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "NegotiationEvent" DROP CONSTRAINT "NegotiationEvent_negotiationId_fkey";

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "parseMetadata" JSONB;

-- DropTable
DROP TABLE "NegotiationEvent";
