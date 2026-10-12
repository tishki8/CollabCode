import type { PrismaClient } from "@collabcode/db";
import type { AuthorshipStore, NewEvent } from "./tracker";

export function createPrismaStore(prisma: PrismaClient): AuthorshipStore {
  return {
    async loadOwners(fileId) {
      const rows = await prisma.yClient.findMany({ where: { fileId }, select: { clientId: true, userId: true } });
      return new Map(rows.map((r) => [Number(r.clientId), r.userId]));
    },

    async loadCoverage(fileId) {
      const rows = await prisma.docEvent.findMany({
        where: { fileId },
        select: { clientId: true, clockStart: true, clockEnd: true }, // never the heavy `update` column
      });
      return rows.filter((r) => r.clockEnd > r.clockStart).map((r) => ({ client: Number(r.clientId), start: r.clockStart, end: r.clockEnd }));
    },

    async bindClient(fileId, clientId, userId) {
      // First writer wins: the primary key makes this atomic, even across server instances.
      await prisma.yClient.createMany({ data: [{ fileId, clientId: BigInt(clientId), userId }], skipDuplicates: true });
      const row = await prisma.yClient.findUniqueOrThrow({ where: { fileId_clientId: { fileId, clientId: BigInt(clientId) } } });
      return row.userId;
    },

    async writeEvents(rows: NewEvent[]) {
      await prisma.docEvent.createMany({
        data: rows.map((r) => ({
          fileId: r.fileId,
          userId: r.userId,
          clientId: BigInt(r.clientId),
          clockStart: r.clockStart,
          clockEnd: r.clockEnd,
          update: Buffer.from(r.update),
          added: r.added,
          removed: r.removed,
          linesAdded: r.linesAdded,
          linesRemoved: r.linesRemoved,
          startedAt: r.startedAt,
          createdAt: r.createdAt,
        })),
      });
    },
  };
}
