// Persists each file's Yjs document as a single compacted snapshot (one row per file).
// Hocuspocus debounces writes, stores again on the last disconnect, and rebuilds the
// document from this row when the file is next opened, so content survives restarts.
import type { PrismaClient } from "@collabcode/db";
import { parseDocumentName } from "./auth";

export function createPersistence(prisma: PrismaClient) {
  return {
    async fetch({ documentName }: { documentName: string }): Promise<Uint8Array | null> {
      const doc = parseDocumentName(documentName);
      if (doc?.kind !== "file") return null; // presence rooms hold no content
      const row = await prisma.docSnapshot.findUnique({ where: { fileId: doc.fileId } });
      return row ? new Uint8Array(row.state) : null;
    },

    async store({ documentName, state }: { documentName: string; state: Buffer }): Promise<void> {
      const doc = parseDocumentName(documentName);
      if (doc?.kind !== "file") return;
      const bytes = new Uint8Array(state);
      await prisma.docSnapshot.upsert({
        where: { fileId: doc.fileId },
        update: { state: bytes },
        create: { fileId: doc.fileId, state: bytes },
      });
    },
  };
}
