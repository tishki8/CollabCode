import type { Prisma, PrismaClient } from "@collabcode/db";
import { bytesToBase64, type CheckpointDto, type CommentDto, type PersonDto, type SuggestionDto, type SuggestionStatus, type ThreadDto } from "@collabcode/shared";
import { describePeople } from "./people";

const anchorsOf = (start: Uint8Array, end: Uint8Array) => ({
  start: bytesToBase64(new Uint8Array(start)),
  end: bytesToBase64(new Uint8Array(end)),
  collapsed: Buffer.compare(Buffer.from(start), Buffer.from(end)) === 0,
});

/** Look people up once for a whole page of rows. */
async function peopleMap(prisma: PrismaClient, projectId: string, ids: (string | null | undefined)[]): Promise<Map<string, PersonDto>> {
  const list = await describePeople(prisma, projectId, ids.filter((x): x is string => !!x));
  return new Map(list.map((p) => [p.id, p]));
}

const fallback = (id: string): PersonDto => ({ id, name: "Unknown user", isGuest: false, color: "#666666", initials: "?" });

export async function suggestionDtos(
  prisma: PrismaClient,
  projectId: string,
  rows: Prisma.SuggestionGetPayload<object>[],
): Promise<SuggestionDto[]> {
  const people = await peopleMap(prisma, projectId, rows.flatMap((r) => [r.authorId, r.resolvedById]));
  const p = (id: string) => people.get(id) ?? fallback(id);
  return rows.map((r) => ({
    id: r.id,
    fileId: r.fileId,
    author: p(r.authorId),
    anchors: anchorsOf(r.startAnchor, r.endAnchor),
    originalText: r.originalText,
    newText: r.newText,
    status: r.status as SuggestionStatus,
    createdAt: r.createdAt.toISOString(),
    resolvedBy: r.resolvedById ? p(r.resolvedById) : null,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }));
}

export async function threadDtos(
  prisma: PrismaClient,
  projectId: string,
  rows: Prisma.CommentThreadGetPayload<{ include: { comments: true } }>[],
): Promise<ThreadDto[]> {
  const people = await peopleMap(
    prisma,
    projectId,
    rows.flatMap((t) => [t.createdById, t.resolvedById, ...t.comments.map((c) => c.authorId)]),
  );
  const p = (id: string) => people.get(id) ?? fallback(id);
  return rows.map((t) => ({
    id: t.id,
    fileId: t.fileId,
    anchors: anchorsOf(t.startAnchor, t.endAnchor),
    quote: t.quote,
    createdBy: p(t.createdById),
    createdAt: t.createdAt.toISOString(),
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    resolvedBy: t.resolvedById ? p(t.resolvedById) : null,
    comments: [...t.comments]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
      .map((c): CommentDto => ({ id: c.id, author: p(c.authorId), body: c.body, createdAt: c.createdAt.toISOString() })),
  }));
}

export async function checkpointDtos(
  prisma: PrismaClient,
  projectId: string,
  rows: (Prisma.CheckpointGetPayload<object> & { _count: { files: number } })[],
): Promise<CheckpointDto[]> {
  const people = await peopleMap(prisma, projectId, rows.map((r) => r.createdById));
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    createdBy: people.get(c.createdById) ?? fallback(c.createdById),
    createdAt: c.createdAt.toISOString(),
    fileCount: c._count.files,
  }));
}
