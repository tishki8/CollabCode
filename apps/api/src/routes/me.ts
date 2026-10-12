import type { FastifyPluginAsync } from "fastify";
import type { MeDto } from "@collabcode/shared";
import type { Ctx } from "../app";
import { GUEST_COOKIE } from "../plugins/auth";
import { hashToken } from "../services/tokens";

export const meRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    // The web app asks who the caller is (a signed-in user or a guest) to render pages.
    app.get("/me", async (req): Promise<MeDto> => {
      const user = await ctx.user(req);
      return { id: user.id, name: user.name, isGuest: user.isGuest };
    });

    // A guest leaves: delete their session so the cookie stops working. Their past edits stay
    // credited to their name, and they can come back through a link as a new guest.
    app.post("/guest/logout", async (req, reply) => {
      const token = req.cookies[GUEST_COOKIE];
      if (token) await ctx.prisma.guestSession.deleteMany({ where: { tokenHash: hashToken(token) } });
      reply.clearCookie(GUEST_COOKIE, { path: "/" });
      return reply.code(204).send();
    });
  };
