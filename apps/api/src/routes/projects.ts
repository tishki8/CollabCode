import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  LANGUAGE_INFO,
  createProjectInput,
  initialsOf,
  pickColor,
  updateProjectInput,
  type ProjectDetail,
  type ProjectList,
  type ProjectSummary,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction } from "../services/access";
import { resolveFilePath } from "../services/tree";
import { HttpError, forbidden } from "../errors";

const idParams = z.object({ id: z.string().min(1).max(64) });

export const projectRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    // Dashboard: projects I own and projects shared with me.
    app.get("/", async (req): Promise<ProjectList> => {
      const user = await ctx.user(req);
      const memberships = await prisma.projectMember.findMany({
        where: { userId: user.id },
        include: { project: true },
        orderBy: { project: { updatedAt: "desc" } },
      });
      const owners = await prisma.user.findMany({
        where: { id: { in: [...new Set(memberships.map((m) => m.project.ownerId))] } },
        select: { id: true, name: true },
      });
      const ownerName = new Map(owners.map((o) => [o.id, o.name]));

      const out: ProjectList = { mine: [], shared: [] };
      for (const m of memberships) {
        const summary: ProjectSummary = {
          id: m.project.id,
          name: m.project.name,
          language: m.project.language,
          role: m.role,
          ownerName: ownerName.get(m.project.ownerId) ?? "Unknown",
          updatedAt: m.project.updatedAt.toISOString(),
        };
        (m.project.ownerId === user.id ? out.mine : out.shared).push(summary);
      }
      return out;
    });

    app.post("/", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const user = await ctx.user(req);
      // Guests are here for one shared project; they have no account to own anything.
      if (user.isGuest) throw forbidden("Guests cannot create projects. Sign in to create your own.");
      const input = ctx.parse(createProjectInput, req.body);

      // Project + owner membership + default entry file are created together or not at all.
      const project = await prisma.$transaction(async (tx) => {
        const p = await tx.project.create({
          data: { name: input.name, language: input.language, ownerId: user.id },
        });
        await tx.projectMember.create({
          data: {
            projectId: p.id,
            userId: user.id,
            role: "OWNER",
            color: pickColor([]),
            initials: initialsOf(user.name),
          },
        });
        await tx.fileNode.create({
          data: {
            projectId: p.id,
            parentId: null,
            name: LANGUAGE_INFO[input.language].defaultEntryFile,
            type: "FILE",
          },
        });
        return p;
      });
      return reply.code(201).send({ id: project.id });
    });

    app.get("/:id", async (req): Promise<ProjectDetail> => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      const role = await requireAction(prisma, id, user.id, "project:read");
      const p = await prisma.project.findUniqueOrThrow({ where: { id } });
      const owner = await prisma.user.findUnique({ where: { id: p.ownerId }, select: { name: true } });
      return {
        id: p.id,
        name: p.name,
        language: p.language,
        entryFile: p.entryFile,
        role,
        ownerName: owner?.name ?? "Unknown",
        updatedAt: p.updatedAt.toISOString(),
      };
    });

    app.patch("/:id", async (req) => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      const input = ctx.parse(updateProjectInput, req.body);
      await requireAction(prisma, id, user.id, "project:update");

      if (input.entryFile) {
        // The entry file must be an existing (non-deleted) file in this project.
        const nodes = await prisma.fileNode.findMany({
          where: { projectId: id, deletedAt: null },
          select: { id: true, parentId: true, name: true, type: true },
        });
        if (!resolveFilePath(nodes, input.entryFile)) {
          throw new HttpError(400, "Entry file does not exist in this project");
        }
      }
      await prisma.project.update({
        where: { id },
        data: { name: input.name, entryFile: input.entryFile },
      });
      return { ok: true };
    });

    app.delete("/:id", async (req, reply) => {
      const user = await ctx.user(req);
      const { id } = ctx.parse(idParams, req.params);
      await requireAction(prisma, id, user.id, "project:delete");
      await prisma.project.delete({ where: { id } });
      return reply.code(204).send();
    });
  };
