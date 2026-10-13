-- AlterTable
ALTER TABLE "DocEvent" ADD COLUMN     "linesAdded" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "linesRemoved" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "DocEvent_fileId_id_idx" ON "DocEvent"("fileId", "id");
