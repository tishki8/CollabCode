import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  createShareLinkInput,
  joinShareLinkInput,
  type CreatedShareLinkDto,
  type JoinResult,
  type ShareLinkDto,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction } from "../services/access";
import { hashShareToken, joinViaShareLink, newShareToken } from "../services/share-links";
import { notFound } from "../errors";

const idSchema = z.string().min(1).max(64);
const projectParams = z.object({ id: idSchema });
const linkParams = z.object({ id: idSchema, linkId: idSchema });

export const shareLinkRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    // Owner: create a link. The raw token is returned once and only its hash is stored.
    app.post(
      "/projects/:id/share-links",
      { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const user = await ctx.user(req);
        const { id: projectId } = ctx.parse(projectParams, req.params);
        const input = ctx.parse(createShareLinkInput, req.body);
        await requireAction(prisma, projectId, user.id, "share:manage");

        const token = newShareToken();
        const link = await prisma.shareLink.create({
          data: { projectId, tokenHash: hashShareToken(token), role: input.role, createdById: user.id },
        });
        const dto: CreatedShareLinkDto = { id: link.id, role: link.role, createdAt: link.createdAt.toISOString(), token };
        return reply.code(201).send(dto);
      },
    );

    // Owner: list active (not revoked) links. Tokens are not included: they aren't stored.
    app.get("/projects/:id/share-links", async (req): Promise<ShareLinkDto[]> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(projectParams, req.params);
      await requireAction(prisma, projectId, user.id, "share:manage");
      const links = await prisma.shareLink.findMany({
        where: { projectId, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return links.map((l) => ({ id: l.id, role: l.role, createdAt: l.createdAt.toISOString() }));
    });

    // Owner: revoke. People who already joined keep their access; the link stops working.
    app.delete("/projects/:id/share-links/:linkId", async (req, reply) => {
      const user = await ctx.user(req);
      const { id: projectId, linkId } = ctx.parse(linkParams, req.params);
      await requireAction(prisma, projectId, user.id, "share:manage");
      // Scope by projectId so an owner can't revoke another project's link by guessing ids.
      const { count } = await prisma.shareLink.updateMany({
        where: { id: linkId, projectId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) {
        const exists = await prisma.shareLink.findFirst({ where: { id: linkId, projectId }, select: { id: true } });
        if (!exists) throw notFound("Link not found"); // already-revoked links stay a no-op success
      }
      return reply.code(204).send();
    });

    // Any signed-in user: open a link and become a member with the link's role.
    app.post(
      "/share-links/join",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req): Promise<JoinResult> => {
        const user = await ctx.user(req);
        const { token } = ctx.parse(joinShareLinkInput, req.body);
        return joinViaShareLink(prisma, token, user);
      },
    );
  };
