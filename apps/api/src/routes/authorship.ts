import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as Y from "yjs";
import { replayChanges } from "@collabcode/shared/yjs";
import {
  MAX_REPLAY_EVENTS,
  attribute,
  blameLines,
  textRuns,
  AttributionIndex,
  timeline,
  totalsByUser,
  type AttributionResponse,
  type ContributionsResponse,
  type EventsResponse,
  type HistoryDiffResponse,
  type MemberDto,
  type EventSummary,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction } from "../services/access";
import { describePeople } from "../services/people";
import { HttpError, notFound } from "../errors";

const id = z.string().min(1).max(64);
const fileParams = z.object({ id });
const projectParams = z.object({ id });
const cursor = z.string().regex(/^\d{1,18}$/);
const date = z.coerce.date();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_BUCKETS = 400;
const MAX_SUMMARY_EVENTS = 200_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_HUNK_TEXT = 2_000;
const MAX_HUNKS = 2_000;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_FILES_FOR_BLAME = 100;

export const authorshipRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    /** A live file the caller may read. Returns its project too. */
    async function readableFile(userId: string, fileId: string) {
      const node = await prisma.fileNode.findFirst({ where: { id: fileId, type: "FILE", deletedAt: null } });
      if (!node) throw notFound("File not found");
      await requireAction(prisma, node.projectId, userId, "file:read");
      return node;
    }

    // ---- who is in the project (for filters and legends) ----
    app.get("/projects/:id/members", async (req): Promise<MemberDto[]> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(projectParams, req.params);
      await requireAction(prisma, projectId, user.id, "project:read");
      const rows = await prisma.projectMember.findMany({
        where: { projectId },
        include: { user: { select: { name: true, isGuest: true } } },
        orderBy: { joinedAt: "asc" },
      });
      return rows.map((m) => ({ id: m.userId, name: m.user.name, isGuest: m.user.isGuest, role: m.role, color: m.color, initials: m.initials }));
    });

    // ---- attribution ranges for blame / colours (fetched incrementally) ----
    app.get("/files/:id/attribution", async (req): Promise<AttributionResponse> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(fileParams, req.params);
      const q = ctx.parse(z.object({ after: cursor.optional(), limit: z.coerce.number().int().min(1).max(50_000).default(20_000) }), req.query);
      const node = await readableFile(user.id, fileId);

      const rows = await prisma.docEvent.findMany({
        where: { fileId, ...(q.after ? { id: { gt: BigInt(q.after) } } : {}) },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        select: { id: true, userId: true, clientId: true, clockStart: true, clockEnd: true, createdAt: true, recovered: true }, // never the heavy `update`
      });
      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;
      const users = await describePeople(prisma, node.projectId, page.map((r) => r.userId));
      const index = new Map(users.map((u, i) => [u.id, i]));
      return {
        users,
        ranges: page
          .filter((r) => r.clockEnd > r.clockStart)
          .map((r) => [Number(r.clientId), r.clockStart, r.clockEnd, index.get(r.userId)!, r.createdAt.getTime(), String(r.id), r.recovered ? 1 : 0]),
        lastEventId: page.length ? String(page[page.length - 1]!.id) : null,
        hasMore,
      };
    });

    // ---- timeline of changes, filterable by person and time ----
    app.get("/files/:id/events", async (req): Promise<EventsResponse> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(fileParams, req.params);
      const q = ctx.parse(
        z.object({
          userId: id.optional(),
          from: date.optional(),
          to: date.optional(),
          before: cursor.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
        req.query,
      );
      const node = await readableFile(user.id, fileId);
      const rows = await prisma.docEvent.findMany({
        where: {
          fileId,
          ...(q.userId ? { userId: q.userId } : {}),
          ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
          ...(q.before ? { id: { lt: BigInt(q.before) } } : {}),
        },
        orderBy: { id: "desc" },
        take: q.limit + 1,
        select: { id: true, userId: true, startedAt: true, createdAt: true, added: true, removed: true, linesAdded: true, linesRemoved: true, origin: true, recovered: true },
      });
      const more = rows.length > q.limit;
      const page = more ? rows.slice(0, q.limit) : rows;
      return {
        users: await describePeople(prisma, node.projectId, page.map((r) => r.userId)),
        events: page.map((r) => ({
          id: String(r.id),
          userId: r.userId,
          startedAt: r.startedAt.toISOString(),
          endedAt: r.createdAt.toISOString(),
          added: r.added,
          removed: r.removed,
          linesAdded: r.linesAdded,
          linesRemoved: r.linesRemoved,
          origin: r.origin,
          recovered: r.recovered,
        })),
        nextBefore: more ? String(page[page.length - 1]!.id) : null,
      };
    });

    // ---- a diff of what one person changed in a time range ----
    app.get(
      "/files/:id/history-diff",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req): Promise<HistoryDiffResponse> => {
        const user = await ctx.user(req);
        const { id: fileId } = ctx.parse(fileParams, req.params);
        const q = ctx.parse(z.object({ userId: id, from: date.optional(), to: date.optional() }), req.query);
        const node = await readableFile(user.id, fileId);

        // Replay needs every event up to the end of the range, from the beginning of the log.
        const upTo = q.to ? { createdAt: { lte: q.to } } : {};
        const total = await prisma.docEvent.count({ where: { fileId, ...upTo } });
        if (total > MAX_REPLAY_EVENTS) {
          throw new HttpError(
            413,
            `This file has ${total.toLocaleString()} recorded changes up to that point; history can replay at most ${MAX_REPLAY_EVENTS.toLocaleString()}. Try an earlier end date.`,
            undefined,
            "REPLAY_TOO_LARGE",
          );
        }
        const events: { id: bigint; userId: string; startedAt: number; endedAt: number; update: Uint8Array }[] = [];
        let bytes = 0;
        for (let after = 0n; ; ) {
          const page = await prisma.docEvent.findMany({
            where: { fileId, id: { gt: after }, ...upTo },
            orderBy: { id: "asc" },
            take: 1000,
          });
          if (page.length === 0) break;
          for (const e of page) {
            bytes += e.update.byteLength;
            events.push({ id: e.id, userId: e.userId, startedAt: e.startedAt.getTime(), endedAt: e.createdAt.getTime(), update: new Uint8Array(e.update) });
          }
          if (bytes > MAX_REPLAY_BYTES) {
            throw new HttpError(413, "This file's history is too large to replay. Try an earlier end date.", undefined, "REPLAY_TOO_LARGE");
          }
          after = page[page.length - 1]!.id;
        }

        const changes = replayChanges(events, { userId: q.userId, from: q.from?.getTime(), to: q.to?.getTime() });
        let hunkCount = 0;
        const trimmed = changes.map((c) => ({
          eventId: c.eventId,
          userId: c.userId,
          at: new Date(c.at).toISOString(),
          hunks: c.hunks.flatMap((h) => {
            if (hunkCount++ >= MAX_HUNKS) return [];
            return [h.text.length > MAX_HUNK_TEXT ? { ...h, text: h.text.slice(0, MAX_HUNK_TEXT), truncated: true } : h];
          }),
        }));
        return { users: await describePeople(prisma, node.projectId, [q.userId]), changes: trimmed.filter((c) => c.hunks.length), replayedEvents: events.length };
      },
    );

    // ---- contribution summary for the whole project ----
    app.get("/projects/:id/contributions", async (req): Promise<ContributionsResponse> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(projectParams, req.params);
      const q = ctx.parse(z.object({ from: date.optional(), to: date.optional(), bucket: z.enum(["hour", "day"]).optional() }), req.query);
      await requireAction(prisma, projectId, user.id, "project:read");

      // Include soft-deleted files: their history still counts as work done.
      const files = await prisma.fileNode.findMany({ where: { projectId, type: "FILE" }, select: { id: true, deletedAt: true } });
      const fileIds = files.map((f) => f.id);
      const range = {
        ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      };
      const rows = await prisma.docEvent.findMany({
        where: { fileId: { in: fileIds }, ...range },
        orderBy: { id: "asc" },
        take: MAX_SUMMARY_EVENTS + 1,
        select: { userId: true, startedAt: true, createdAt: true, added: true, removed: true, linesAdded: true, linesRemoved: true },
      });
      const truncated = rows.length > MAX_SUMMARY_EVENTS;
      const events: EventSummary[] = rows.slice(0, MAX_SUMMARY_EVENTS).map((r) => ({
        userId: r.userId,
        startedAt: r.startedAt.getTime(),
        endedAt: r.createdAt.getTime(),
        added: r.added,
        removed: r.removed,
        linesAdded: r.linesAdded,
        linesRemoved: r.linesRemoved,
      }));

      const now = Date.now();
      const from = q.from?.getTime() ?? (events.length ? Math.min(...events.map((e) => e.startedAt)) : now - DAY);
      const to = Math.max(q.to?.getTime() ?? now, from + 1);
      let bucketMs = q.bucket === "hour" ? HOUR : q.bucket === "day" ? DAY : to - from <= 3 * DAY ? HOUR : DAY;
      while ((to - from) / bucketMs > MAX_BUCKETS) bucketMs *= 2; // keep the timeline a sensible size

      const totals = totalsByUser(events);
      const tl = timeline(events, from, to, bucketMs);
      const people = await describePeople(prisma, projectId, totals.map((t) => t.userId));
      const survivingLines = await survivingLinesByUser(
        files.filter((f) => !f.deletedAt).map((f) => f.id).slice(0, MAX_FILES_FOR_BLAME),
      );

      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucketMs,
        people: totals.map((t) => ({
          ...people.find((p) => p.id === t.userId)!,
          added: t.added,
          removed: t.removed,
          linesAdded: t.linesAdded,
          linesRemoved: t.linesRemoved,
          activeMs: t.activeMs,
          sessions: t.sessions,
          firstAt: new Date(t.firstAt).toISOString(),
          lastAt: new Date(t.lastAt).toISOString(),
          survivingLines: survivingLines.get(t.userId) ?? 0,
        })),
        lanes: tl.lanes,
        truncated,
      };
    });

    /** For each person, how many lines of the saved version of the project have them as main author. */
    async function survivingLinesByUser(fileIds: string[]): Promise<Map<string, number>> {
      const out = new Map<string, number>();
      if (fileIds.length === 0) return out;
      const snapshots = await prisma.docSnapshot.findMany({ where: { fileId: { in: fileIds } } });
      for (const snap of snapshots) {
        if (snap.state.byteLength > MAX_SNAPSHOT_BYTES) continue;
        const ranges = await prisma.docEvent.findMany({
          where: { fileId: snap.fileId, clockEnd: { gt: 0 } },
          select: { userId: true, clientId: true, clockStart: true, clockEnd: true, createdAt: true, recovered: true },
        });
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(snap.state));
        const text = doc.getText("content");
        const index = new AttributionIndex(
          ranges.filter((r) => r.clockEnd > r.clockStart).map((r) => ({ client: Number(r.clientId), start: r.clockStart, end: r.clockEnd, user: r.userId, at: r.createdAt.getTime(), recovered: r.recovered })),
        );
        for (const line of blameLines(text.toString(), attribute(textRuns(text), index))) {
          if (line.main?.user && line.main.chars > 0) out.set(line.main.user, (out.get(line.main.user) ?? 0) + 1);
        }
        doc.destroy();
      }
      return out;
    }
  };
