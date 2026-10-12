import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { CollabTokenResponse } from "@collabcode/shared";
import { signCollabToken } from "@collabcode/shared/collab-token";
import type { Ctx } from "../app";
import { notFound } from "../errors";

const params = z.object({ id: z.string().min(1).max(64) });

export const collabRoutes =
  (ctx: Ctx, opts: { secret: string; publicUrl: string }): FastifyPluginAsync =>
  async (app) => {
    // Gives a signed-in project member a short-lived token for the collab WebSocket, plus the
    // identity (name, colour, initials) their cursor will show. The token proves who they are;
    // the collab server looks up the role itself on every connection.
    app.get(
      "/projects/:id/collab-token",
      { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (req): Promise<CollabTokenResponse> => {
        const user = await ctx.user(req);
        const { id: projectId } = ctx.parse(params, req.params);
        const member = await ctx.prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: user.id } },
          select: { role: true, color: true, initials: true },
        });
        if (!member) throw notFound("Project not found");
        return {
          token: await signCollabToken(user.id, opts.secret),
          url: opts.publicUrl,
          role: member.role,
          user: { id: user.id, name: user.name, color: member.color, initials: member.initials, isGuest: user.isGuest },
        };
      },
    );
  };
