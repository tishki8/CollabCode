-- CreateTable
CREATE TABLE "CheckpointRestore" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetCheckpointId" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "fileId" TEXT,
    "filePath" TEXT,
    "autoSaveId" TEXT NOT NULL,
    "undoOfId" TEXT,
    "undoneById" TEXT,
    "restored" INTEGER NOT NULL DEFAULT 0,
    "recreated" INTEGER NOT NULL DEFAULT 0,
    "removed" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckpointRestore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckpointRestore_projectId_createdAt_idx" ON "CheckpointRestore"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "CheckpointRestore" ADD CONSTRAINT "CheckpointRestore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
