import type { Extension } from "@hocuspocus/server";
import type { PrismaClient } from "@collabcode/db";
import { parseDocumentName, type ConnContext } from "../auth";
import { extractSyncUpdate } from "./frame";
import { createPrismaStore } from "./prisma-store";
import { AuthorshipTracker, type TrackerOptions } from "./tracker";

const fileIdOf = (documentName: string): string | null => {
  const doc = parseDocumentName(documentName);
  return doc?.kind === "file" ? doc.fileId : null;
};

/**
 * Hocuspocus extension that feeds the tracker.
 *
 * Priority 1000 (the database extension is 100): hooks run in priority order, so for every
 * snapshot store the authorship events are written FIRST. A snapshot therefore never contains text
 * whose attribution is still only in memory.
 */
export function createAuthorshipExtension(prisma: PrismaClient, opts: Partial<Omit<TrackerOptions, "store">> = {}) {
  const tracker = new AuthorshipTracker({ store: createPrismaStore(prisma), ...opts });

  const extension: Extension<ConnContext> = {
    extensionName: "authorship",
    priority: 1000,

    async afterLoadDocument({ documentName }) {
      const fileId = fileIdOf(documentName);
      if (fileId) await tracker.loadDocument(fileId);
    },

    // Runs BEFORE a client message is applied. Read-only connections are skipped: their updates are
    // refused by Hocuspocus anyway and must never be recorded as someone's work.
    async beforeHandleMessage({ documentName, document, connection, context, update }) {
      const fileId = fileIdOf(documentName);
      if (!fileId || connection.readOnly) return;
      const yjsUpdate = extractSyncUpdate(update);
      if (!yjsUpdate) return;
      // The author is the authenticated user of THIS connection (loaded from the database at connect time).
      await tracker.onDelivery(fileId, document, context.userId, yjsUpdate);
    },

    // The clientIDs in a connection's awareness updates are its own: claim them, or reject the update.
    async beforeHandleAwareness({ documentName, states, context }) {
      const fileId = fileIdOf(documentName);
      if (!fileId || !context) return; // presence rooms and relayed updates carry no ownership
      const ids = [...states.entries()].filter(([, state]) => state !== null && state !== undefined).map(([id]) => id);
      await tracker.onAwareness(fileId, context.userId, ids);
    },

    async onStoreDocument({ documentName }) {
      const fileId = fileIdOf(documentName);
      if (fileId) await tracker.flushDocument(fileId);
    },

    async onDisconnect({ documentName }) {
      const fileId = fileIdOf(documentName);
      if (fileId) await tracker.flushDocument(fileId);
    },

    async afterUnloadDocument({ documentName }) {
      const fileId = fileIdOf(documentName);
      if (fileId) await tracker.unloadDocument(fileId);
    },

    async onDestroy() {
      await tracker.flushAll();
    },
  };

  return { extension, tracker };
}
