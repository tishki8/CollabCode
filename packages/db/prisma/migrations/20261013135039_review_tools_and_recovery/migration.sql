-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "DocEvent" ADD COLUMN     "recovered" BOOLEAN NOT NULL DEFAULT false;
