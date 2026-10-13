// Named checkpoints (a snapshot of every file in the project), restore, and the data the replay
// player needs (checkpoints double as replay starting points).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import * as Y from "yjs";
import {
  MAX_REPLAY_EVENTS,
  bytesToBase64,
  createCheckpointInput,
  restoreCheckpointInput,
  type CheckpointDetailDto,
  type CheckpointDto,
  type ReplayPointDto,
  type ReplayResponse,
  type RestoreEventDto,
  type RestoreResultDto,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction } from "../services/access";
import type { CollabClient } from "../services/collab";
import { describePeople } from "../services/people";
import { checkpointDtos } from "../services/review-dto";
import { pathOf, resolveFilePath } from "../services/tree";
import { HttpError, conflict, notFound } from "../errors";

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

    // Only user-named checkpoints are listed. The automatic saves taken before restores exist (they
    // power "Undo this restore") but are never shown here, never pruned, and never have a user-chosen name.
    app.get("/projects/:id/checkpoints", async (req): Promise<CheckpointDto[]> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(idParams, req.params);
      await requireAction(prisma, projectId, user.id, "project:read");
      const rows = await prisma.checkpoint.findMany({
        where: { projectId, automatic: false },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { files: true } } },
      });
      return checkpointDtos(prisma, projectId, rows);
    });

    app.post("/projects/:id/checkpoints", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(createCheckpointInput, req.body);
      await requireAction(prisma, projectId, user.id, "checkpoint:create");
      const cpId = await createCheckpoint(projectId, input.name, user.id, false);
      return reply.code(201).send((await checkpointDtos(prisma, projectId, [await withCount(cpId)]))[0]);
    });

    /** A user-named checkpoint (automatic saves are invisible to this API: 404). */
    async function loadCheckpoint(userId: string, checkpointId: string, action: Parameters<typeof requireAction>[3]) {
      const cp = await prisma.checkpoint.findUnique({ where: { id: checkpointId }, include: { _count: { select: { files: true } } } });
      if (!cp || cp.automatic) throw notFound("Checkpoint not found");
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

    interface RestoreJob {
      userId: string;
      projectId: string;
      /** The snapshot to restore (user-named, or, for an undo, the hidden automatic save). */
      checkpointId: string;
      /** The user-named checkpoint this is about (shown in History). */
      targetName: string;
      kind: "restore" | "undo";
      undoOfId?: string;
      /** Restore just this file; omit for the whole project. */
      fileId?: string;
    }

    /**
     * Restore a file or the whole project. Does nothing at all (no automatic save, no history entry)
     * when the current content already matches. Otherwise: an automatic save is taken first (its name
     * is fixed text plus a timestamp, never derived from any checkpoint's name), the files are set
     * with normal edits credited to the restorer (event origin "restore"), and the restore is recorded
     * in History together with the id of that automatic save, which "Undo this restore" goes back to.
     */
    async function runRestore(job: RestoreJob): Promise<RestoreResultDto> {
      const { userId, projectId } = job;
      const files = await prisma.checkpointFile.findMany({ where: { checkpointId: job.checkpointId, ...(job.fileId ? { fileId: job.fileId } : {}) } });
      const nodes = await allNodes(projectId);
      const byId = new Map(nodes.map((n) => [n.id, n]));

      // A file-scope undo of a restore that brought a deleted file back: the automatic save does not
      // contain the file, so going back means deleting it again.
      const goesAway = job.fileId !== undefined && files.length === 0 && job.kind === "undo";
      if (job.fileId && files.length === 0 && !goesAway) throw notFound("That file is not part of this checkpoint");

      // Is there anything to do? Compare against what the server has right now.
      const live = nodes.filter((n) => !n.deletedAt && n.type === "FILE");
      const toCheck = job.fileId ? live.filter((n) => n.id === job.fileId) : live;
      await collab.flush(toCheck.map((n) => n.id));
      const snaps = await prisma.docSnapshot.findMany({ where: { fileId: { in: toCheck.map((n) => n.id) } } });
      const currentOf = new Map(snaps.map((x) => [x.fileId, textOf(new Uint8Array(x.state))]));
      let differs = goesAway ? !!byId.get(job.fileId!) && !byId.get(job.fileId!)!.deletedAt : false;
      for (const f of files) {
        const node = byId.get(f.fileId);
        if (!node) continue;
        if (node.deletedAt || (currentOf.get(f.fileId) ?? "") !== textOf(new Uint8Array(f.state))) differs = true;
      }
      if (!job.fileId) {
        const inCheckpoint = new Set(files.map((f) => f.fileId));
        if (live.some((n) => !inCheckpoint.has(n.id))) differs = true;
      }
      if (!differs) return { status: "already", restoreId: null, restored: 0, recreated: 0, removed: 0 };

      const autoSave = await createCheckpoint(projectId, `auto-save before restore · ${new Date().toISOString()}`, userId, true);
      const counts = { restored: 0, recreated: 0, removed: 0 };

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
        if (chain.length > 0) counts.recreated++;
      }

      for (const f of files) {
        const node = byId.get(f.fileId);
        if (!node) continue; // the file row is gone for good: nothing to restore into
        if (node.deletedAt) await undelete(node.id);
        const res = await collab.edit({
          fileId: f.fileId,
          userId, // credited to whoever restores
          origin: "restore",
          op: { type: "set-text", text: textOf(new Uint8Array(f.state)) },
        });
        if (res.status === "applied") counts.restored++;
      }

      if (goesAway) {
        await prisma.fileNode.update({ where: { id: job.fileId! }, data: { deletedAt: new Date() } });
        counts.removed = 1;
      } else if (!job.fileId) {
        // Whole project: files created after the checkpoint go away (soft delete, so history keeps working
        // and the automatic save can bring them back).
        const inCheckpoint = new Set(files.map((f) => f.fileId));
        const extra = nodes.filter((n) => n.type === "FILE" && !n.deletedAt && !inCheckpoint.has(n.id));
        if (extra.length > 0) {
          await prisma.fileNode.updateMany({ where: { id: { in: extra.map((n) => n.id) } }, data: { deletedAt: new Date() } });
          counts.removed = extra.length;
        }
      }
      // An entry file that no longer exists falls back to the language default.
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { entryFile: true } });
      if (project?.entryFile) {
        const now = await prisma.fileNode.findMany({ where: { projectId, deletedAt: null }, select: { id: true, parentId: true, name: true, type: true } });
        if (!resolveFilePath(now, project.entryFile)) await prisma.project.update({ where: { id: projectId }, data: { entryFile: null } });
      }

      const after = await allNodes(projectId);
      const row = await prisma.checkpointRestore.create({
        data: {
          projectId,
          userId,
          kind: job.kind,
          targetCheckpointId: job.checkpointId,
          targetName: job.targetName,
          scope: job.fileId ? "file" : "project",
          fileId: job.fileId ?? null,
          filePath: job.fileId ? (pathOf(after.filter((n) => !n.deletedAt || n.id === job.fileId), job.fileId) ?? files[0]?.path ?? null) : null,
          autoSaveId: autoSave,
          undoOfId: job.undoOfId ?? null,
          ...counts,
        },
      });
      if (job.undoOfId) await prisma.checkpointRestore.update({ where: { id: job.undoOfId }, data: { undoneById: row.id } });
      return { status: "restored", restoreId: row.id, ...counts };
    }

    app.post("/checkpoints/:id/restore", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<RestoreResultDto> => {
      const user = await ctx.user(req);
      const { id: checkpointId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(restoreCheckpointInput, req.body ?? {});
      const cp = await loadCheckpoint(user.id, checkpointId, "checkpoint:restore");
      return runRestore({ userId: user.id, projectId: cp.projectId, checkpointId, targetName: cp.name, kind: "restore", fileId: input.fileId });
    });

    // Undo a restore: restore the hidden automatic save taken just before it. This is itself a restore
    // (a new history entry credited to whoever undoes it, with its own hidden automatic save), so it can be undone too.
    app.post("/restores/:id/undo", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<RestoreResultDto> => {
      const user = await ctx.user(req);
      const { id: restoreId } = ctx.parse(idParams, req.params);
      const row = await prisma.checkpointRestore.findUnique({ where: { id: restoreId } });
      if (!row) throw notFound("Restore not found");
      await requireAction(prisma, row.projectId, user.id, "checkpoint:restore");
      if (row.undoneById) throw conflict("This restore was already undone");
      return runRestore({
        userId: user.id,
        projectId: row.projectId,
        checkpointId: row.autoSaveId,
        targetName: row.targetName,
        kind: "undo",
        undoOfId: row.id,
        fileId: row.fileId ?? undefined,
      });
    });

    // Restores (and undos) that touched a file: whole-project ones and ones of this file. Newest first.
    app.get("/files/:id/restores", async (req): Promise<RestoreEventDto[]> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      const node = await readableFile(user.id, fileId);
      const rows = await prisma.checkpointRestore.findMany({
        where: { projectId: node.projectId, OR: [{ scope: "project" }, { fileId }] },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      const people = new Map((await describePeople(prisma, node.projectId, rows.map((r) => r.userId))).map((p) => [p.id, p]));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind as "restore" | "undo",
        user: people.get(r.userId)!,
        targetName: r.targetName,
        scope: r.scope as "project" | "file",
        filePath: r.filePath,
        createdAt: r.createdAt.toISOString(),
        undone: r.undoneById !== null,
        restored: r.restored,
        recreated: r.recreated,
        removed: r.removed,
      }));
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
        where: { fileId, checkpoint: { automatic: false } }, // only user-named checkpoints
        select: { lastEventId: true, checkpoint: { select: { id: true, name: true, createdAt: true } } },
        orderBy: { checkpoint: { createdAt: "desc" } },
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
        const cf = await prisma.checkpointFile.findFirst({ where: { checkpointId: q.checkpointId, fileId, checkpoint: { projectId: node.projectId, automatic: false } } });
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
