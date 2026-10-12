import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  MAX_FILES_PER_PROJECT,
  MAX_TREE_DEPTH,
  createNodeInput,
  renameNodeInput,
  type FileNodeDto,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction } from "../services/access";
import { depthOf, pathOf, resolveFilePath, subtreeIds } from "../services/tree";
import { HttpError, conflict, notFound } from "../errors";

const idParams = z.object({ id: z.string().min(1).max(64) });
const nodeSelect = { id: true, parentId: true, name: true, type: true } as const;

export const fileRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    const liveNodes = (projectId: string) =>
      prisma.fileNode.findMany({
        where: { projectId, deletedAt: null },
        select: nodeSelect,
        orderBy: { name: "asc" },
      });

    // If the project's configured entry file was renamed/deleted, fall back to the language default.
    async function resetEntryFileIfBroken(projectId: string) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { entryFile: true } });
      if (!project?.entryFile) return;
      if (!resolveFilePath(await liveNodes(projectId), project.entryFile)) {
        await prisma.project.update({ where: { id: projectId }, data: { entryFile: null } });
      }
    }

    app.get("/projects/:id/files", async (req): Promise<FileNodeDto[]> => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      await requireAction(prisma, id, user.id, "file:read");
      return liveNodes(id);
    });

    app.post(
      "/projects/:id/files",
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const user = await ctx.user(req);
        const { id: projectId } = ctx.parse(idParams, req.params);
        const input = ctx.parse(createNodeInput, req.body);
        await requireAction(prisma, projectId, user.id, "file:manage");

        const nodes = await liveNodes(projectId);
        if (nodes.length >= MAX_FILES_PER_PROJECT) {
          throw new HttpError(400, `A project can hold at most ${MAX_FILES_PER_PROJECT} files and folders`);
        }
        if (input.parentId) {
          // The parent must be a live folder of THIS project (never trust a client-supplied id).
          const parent = nodes.find((n) => n.id === input.parentId);
          if (!parent || parent.type !== "FOLDER") throw new HttpError(400, "Parent folder not found");
          if (depthOf(nodes, input.parentId) >= MAX_TREE_DEPTH) {
            throw new HttpError(400, `Folders can be nested at most ${MAX_TREE_DEPTH} levels deep`);
          }
        }
        if (nodes.some((n) => n.parentId === input.parentId && n.name === input.name)) {
          throw conflict(`"${input.name}" already exists in this folder`);
        }

        const node = await prisma.fileNode.create({
          data: { projectId, parentId: input.parentId, name: input.name, type: input.type },
          select: nodeSelect,
        });
        return reply.code(201).send(node);
      },
    );

    // Load a node and check the caller may manage files in its project.
    async function loadManagedNode(userId: string, nodeId: string) {
      const node = await prisma.fileNode.findFirst({ where: { id: nodeId, deletedAt: null } });
      if (!node) throw notFound("File not found");
      await requireAction(prisma, node.projectId, userId, "file:manage");
      return node;
    }

    app.patch("/files/:id", async (req): Promise<FileNodeDto> => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      const input = ctx.parse(renameNodeInput, req.body);
      const node = await loadManagedNode(user.id, id);

      const siblings = await liveNodes(node.projectId);
      if (siblings.some((n) => n.id !== id && n.parentId === node.parentId && n.name === input.name)) {
        throw conflict(`"${input.name}" already exists in this folder`);
      }
      const updated = await prisma.fileNode.update({ where: { id }, data: { name: input.name }, select: nodeSelect });
      await resetEntryFileIfBroken(node.projectId);
      return updated;
    });

    // Soft delete: the node and everything under it. Rows stay so history/blame keep working.
    app.delete("/files/:id", async (req, reply) => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      const node = await loadManagedNode(user.id, id);
      const nodes = await liveNodes(node.projectId);
      await prisma.fileNode.updateMany({
        where: { id: { in: subtreeIds(nodes, id) } },
        data: { deletedAt: new Date() },
      });
      await resetEntryFileIfBroken(node.projectId);
      return reply.code(204).send();
    });

    // Exposed for the editor page: full path of a node (e.g. to show breadcrumbs).
    app.get("/files/:id/path", async (req) => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      const node = await prisma.fileNode.findFirst({ where: { id, deletedAt: null } });
      if (!node) throw notFound("File not found");
      await requireAction(prisma, node.projectId, user.id, "file:read");
      return { path: pathOf(await liveNodes(node.projectId), id) };
    });
  };
