// Named checkpoints (a snapshot of every file in the project), restore, and the data the replay
// player needs (checkpoints double as replay starting points).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as Y from "yjs";
import {
  MAX_CHECKPOINTS_PER_PROJECT,
  MAX_REPLAY_EVENTS,
  bytesToBase64,
  createCheckpointInput,
  restoreCheckpointInput,
  type CheckpointDetailDto,
  type CheckpointDto,
  type ReplayPointDto,
  type ReplayResponse,
  type RestoreResultDto,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction } from "../services/access";
import type { CollabClient } from "../services/collab";
import { describePeople } from "../services/people";
import { checkpointDtos } from "../services/review-dto";
import { pathOf, resolveFilePath } from "../services/tree";
import { HttpError, notFound } from "../errors";

const id = z.string().min(1).max(64);
const idParams = z.object({ id });
const cursor = z.string().regex(/^\d{1,18}$/);
const MAX_REPLAY_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;

const EMPTY_DOC = Y.encodeStateAsUpdate(new Y.Doc());
const textOf = (state: Uint8Array): string => {
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  const t = d.getText("content").toString();
  d.destroy();
  return t;
};

export const checkpointRoutes =
  (ctx: Ctx, collab: CollabClient): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    const allNodes = (projectId: string) =>
      prisma.fileNode.findMany({ where: { projectId }, select: { id: true, parentId: true, name: true, type: true, deletedAt: true } });

    /** Snapshot every live file. Returns the new checkpoint's id. */
    async function createCheckpoint(projectId: string, name: string, userId: string, automatic: boolean): Promise<string> {
      const nodes = await allNodes(projectId);
      const live = nodes.filter((n) => !n.deletedAt);
      const files = live.filter((n) => n.type === "FILE");
      const fileIds = files.map((f) => f.id);

      // Order matters. Events up to `lastEventId` are certainly inside the state we are about to read
      // (they were delivered before the flush); a few newer ones may be inside it too, and replaying
      // those on top later is harmless (applying a Yjs update twice changes nothing).
      const last = await prisma.docEvent.groupBy({ by: ["fileId"], where: { fileId: { in: fileIds } }, _max: { id: true } });
      const lastOf = new Map(last.map((l) => [l.fileId, l._max.id ?? 0n]));
      await collab.flush(fileIds); // makes the database copy current, including text typed a moment ago
      const snaps = await prisma.docSnapshot.findMany({ where: { fileId: { in: fileIds } } });
      const snapOf = new Map(snaps.map((s) => [s.fileId, s.state]));

      const cp = await prisma.checkpoint.create({
        data: {
          projectId,
          name,
          automatic,
          createdById: userId,
          files: {
            create: files.map((f) => ({
              fileId: f.id,
              path: pathOf(live, f.id) ?? f.name,
              state: new Uint8Array(snapOf.get(f.id) ?? EMPTY_DOC),
              lastEventId: lastOf.get(f.id) ?? 0n,
            })),
          },
        },
      });
      return cp.id;
    }

    const withCount = (id: string) => prisma.checkpoint.findUniqueOrThrow({ where: { id }, include: { _count: { select: { files: true } } } });

    app.get("/projects/:id/checkpoints", async (req): Promise<CheckpointDto[]> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(idParams, req.params);
      await requireAction(prisma, projectId, user.id, "project:read");
      const rows = await prisma.checkpoint.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: MAX_CHECKPOINTS_PER_PROJECT,
        include: { _count: { select: { files: true } } },
      });
      return checkpointDtos(prisma, projectId, rows);
    });

    app.post("/projects/:id/checkpoints", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(createCheckpointInput, req.body);
      await requireAction(prisma, projectId, user.id, "checkpoint:create");
      if ((await prisma.checkpoint.count({ where: { projectId, automatic: false } })) >= MAX_CHECKPOINTS_PER_PROJECT) {
        throw new HttpError(400, `A project can have at most ${MAX_CHECKPOINTS_PER_PROJECT} checkpoints`);
      }
      const cpId = await createCheckpoint(projectId, input.name, user.id, false);
      return reply.code(201).send((await checkpointDtos(prisma, projectId, [await withCount(cpId)]))[0]);
    });

    async function loadCheckpoint(userId: string, checkpointId: string, action: Parameters<typeof requireAction>[3]) {
      const cp = await prisma.checkpoint.findUnique({ where: { id: checkpointId }, include: { _count: { select: { files: true } } } });
      if (!cp) throw notFound("Checkpoint not found");
      await requireAction(prisma, cp.projectId, userId, action);
      return cp;
    }

    app.get("/checkpoints/:id", async (req): Promise<CheckpointDetailDto> => {
      const user = await ctx.user(req);
      const { id: checkpointId } = ctx.parse(idParams, req.params);
      const cp = await loadCheckpoint(user.id, checkpointId, "project:read");
      const files = await prisma.checkpointFile.findMany({ where: { checkpointId }, select: { fileId: true, path: true }, orderBy: { path: "asc" } });
      const nodes = await prisma.fileNode.findMany({ where: { id: { in: files.map((f) => f.fileId) } }, select: { id: true, deletedAt: true } });
      const deleted = new Map(nodes.map((n) => [n.id, !!n.deletedAt]));
      const [dto] = await checkpointDtos(prisma, cp.projectId, [cp]);
      return { ...dto!, files: files.map((f) => ({ fileId: f.fileId, path: f.path, deleted: deleted.get(f.fileId) ?? true })) };
    });

    // Restore a file, or the whole project, to a checkpoint. The restore is a normal edit credited to
    // the person restoring (event origin "restore"), and a safety checkpoint is taken first so it can be undone.
    app.post("/checkpoints/:id/restore", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req): Promise<RestoreResultDto> => {
      const user = await ctx.user(req);
      const { id: checkpointId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(restoreCheckpointInput, req.body ?? {});
      const cp = await loadCheckpoint(user.id, checkpointId, "checkpoint:restore");
      const files = await prisma.checkpointFile.findMany({ where: { checkpointId, ...(input.fileId ? { fileId: input.fileId } : {}) } });
      if (input.fileId && files.length === 0) throw notFound("That file is not part of this checkpoint");

      const safety = await createCheckpoint(cp.projectId, `Before restoring “${cp.name}”`.slice(0, 80), user.id, true);

      const nodes = await allNodes(cp.projectId);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const result: RestoreResultDto = { safetyCheckpointId: safety, restored: 0, recreated: 0, removed: 0, unchanged: 0 };

      /** Bring a soft-deleted file (and any deleted folders above it) back, renaming on a name clash. */
      async function undelete(nodeId: string) {
        const chain: string[] = [];
        for (let cur = byId.get(nodeId); cur && chain.length < 50; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
          if (cur.deletedAt) chain.unshift(cur.id);
        }
        for (const cid of chain) {
          const n = byId.get(cid)!;
          const taken = (name: string) => nodes.some((o) => o.id !== n.id && !o.deletedAt && o.parentId === n.parentId && o.name === name);
          let name = n.name;
          for (let i = 1; taken(name); i++) name = i === 1 ? `${n.name} (restored)` : `${n.name} (restored ${i})`;
          await prisma.fileNode.update({ where: { id: n.id }, data: { deletedAt: null, name } });
          n.deletedAt = null;
          n.name = name;
        }
        if (chain.length > 0) result.recreated++;
      }

      for (const f of files) {
        const node = byId.get(f.fileId);
        if (!node) continue; // the file row is gone for good: nothing to restore into
        if (node.deletedAt) await undelete(node.id);
        const res = await collab.edit({
          fileId: f.fileId,
          userId: user.id, // credited to whoever restores
          origin: "restore",
          op: { type: "set-text", text: textOf(new Uint8Array(f.state)) },
        });
        if (res.status === "applied") result.restored++;
        else result.unchanged++;
      }

      if (!input.fileId) {
        // Whole project: files created after the checkpoint go away (soft delete, so history keeps working
        // and the safety checkpoint can bring them back).
        const inCheckpoint = new Set(files.map((f) => f.fileId));
        const extra = nodes.filter((n) => n.type === "FILE" && !n.deletedAt && !inCheckpoint.has(n.id));
        if (extra.length > 0) {
          await prisma.fileNode.updateMany({ where: { id: { in: extra.map((n) => n.id) } }, data: { deletedAt: new Date() } });
          result.removed = extra.length;
        }
      }
      // An entry file that no longer exists falls back to the language default.
      const project = await prisma.project.findUnique({ where: { id: cp.projectId }, select: { entryFile: true } });
      if (project?.entryFile) {
        const live = await prisma.fileNode.findMany({ where: { projectId: cp.projectId, deletedAt: null }, select: { id: true, parentId: true, name: true, type: true } });
        if (!resolveFilePath(live, project.entryFile)) await prisma.project.update({ where: { id: cp.projectId }, data: { entryFile: null } });
      }
      return result;
    });

    // ───────────── replay ─────────────

    async function readableFile(userId: string, fileId: string) {
      const node = await prisma.fileNode.findFirst({ where: { id: fileId, type: "FILE", deletedAt: null } });
      if (!node) throw notFound("File not found");
      await requireAction(prisma, node.projectId, userId, "file:read");
      return node;
    }

    // Where can playback start? The beginning, or any checkpoint that contains this file.
    app.get("/files/:id/replay-points", async (req): Promise<ReplayPointDto[]> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      await readableFile(user.id, fileId);
      const rows = await prisma.checkpointFile.findMany({
        where: { fileId },
        select: { lastEventId: true, checkpoint: { select: { id: true, name: true, createdAt: true } } },
        orderBy: { checkpoint: { createdAt: "desc" } },
        take: 50,
      });
      const points: ReplayPointDto[] = [{ checkpointId: null, name: "The beginning", at: null, events: await prisma.docEvent.count({ where: { fileId } }) }];
      for (const r of rows) {
        points.push({
          checkpointId: r.checkpoint.id,
          name: r.checkpoint.name,
          at: r.checkpoint.createdAt.toISOString(),
          events: await prisma.docEvent.count({ where: { fileId, id: { gt: r.lastEventId } } }),
        });
      }
      return points;
    });

    // The raw material for playback: a starting state (a checkpoint's, or empty) and the change events after it.
    app.get("/files/:id/replay", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req): Promise<ReplayResponse> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      const q = ctx.parse(z.object({ checkpointId: id.optional(), after: cursor.optional(), limit: z.coerce.number().int().min(1).max(1000).default(400) }), req.query);
      const node = await readableFile(user.id, fileId);

      let startAfter = 0n;
      let base: ReplayResponse["base"] = null;
      let baseState: Uint8Array = EMPTY_DOC;
      if (q.checkpointId) {
        const cf = await prisma.checkpointFile.findFirst({ where: { checkpointId: q.checkpointId, fileId, checkpoint: { projectId: node.projectId } } });
        if (!cf) throw notFound("That checkpoint does not contain this file");
        startAfter = cf.lastEventId;
        baseState = new Uint8Array(cf.state);
      }
      const totalEvents = await prisma.docEvent.count({ where: { fileId, id: { gt: startAfter } } });
      if (totalEvents > MAX_REPLAY_EVENTS) {
        throw new HttpError(
          413,
          `${totalEvents.toLocaleString()} changes are recorded after that starting point; replay handles at most ${MAX_REPLAY_EVENTS.toLocaleString()}. Start from a later checkpoint.`,
          undefined,
          "REPLAY_TOO_LARGE",
        );
      }
      if (!q.after) base = { checkpointId: q.checkpointId ?? null, state: bytesToBase64(baseState) };

      const after = q.after ? BigInt(q.after) : startAfter;
      const rows = await prisma.docEvent.findMany({
        where: { fileId, id: { gt: after } },
        orderBy: { id: "asc" },
        take: q.limit + 1,
        select: { id: true, userId: true, startedAt: true, createdAt: true, origin: true, update: true },
      });
      let bytes = 0;
      const page: typeof rows = [];
      for (const r of rows.slice(0, q.limit)) {
        if (page.length > 0 && bytes + r.update.byteLength > MAX_REPLAY_PAGE_BYTES) break;
        bytes += r.update.byteLength;
        page.push(r);
      }
      if (bytes > MAX_REPLAY_BYTES) throw new HttpError(413, "This history is too large to replay", undefined, "REPLAY_TOO_LARGE");
      const more = page.length < rows.length;
      return {
        users: await describePeople(prisma, node.projectId, page.map((r) => r.userId)),
        base,
        events: page.map((r) => ({
          id: String(r.id),
          userId: r.userId,
          startedAt: r.startedAt.toISOString(),
          endedAt: r.createdAt.toISOString(),
          origin: r.origin,
          update: bytesToBase64(new Uint8Array(r.update)),
        })),
        nextAfter: more && page.length ? String(page[page.length - 1]!.id) : null,
        totalEvents,
      };
    });
  };
