import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import {
  createShareLinkInput,
  expiryDate,
  joinAsGuestInput,
  joinShareLinkInput,
  previewShareLinkInput,
  type CreatedShareLinkDto,
  type JoinRequestDto,
  type JoinResult,
  type LinkPreview,
  type ShareLinkDto,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { GUEST_COOKIE } from "../plugins/auth";
import { requireAction } from "../services/access";
import {
  approveJoinRequest,
  assertGuestRoom,
  createGuest,
  hashShareToken,
  joinViaLink,
  loadUsableLink,
  newShareToken,
  previewShareLink,
  rejectJoinRequest,
} from "../services/share-links";
import { notFound } from "../errors";

const idSchema = z.string().min(1).max(64);
const projectParams = z.object({ id: idSchema });
const linkParams = z.object({ id: idSchema, linkId: idSchema });
const requestParams = z.object({ id: idSchema, requestId: idSchema });

export const shareLinkRoutes =
  (ctx: Ctx): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    // ---------- owner: manage links ----------

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
          data: {
            projectId,
            tokenHash: hashShareToken(token),
            role: input.role,
            requiresApproval: input.requiresApproval,
            expiresAt: expiryDate(input.expiresIn), // computed here, from the server clock
            createdById: user.id,
          },
        });
        const dto: CreatedShareLinkDto = { ...toDto(link), token };
        return reply.code(201).send(dto);
      },
    );

    // Active (not revoked) links, including expired ones so the owner can see and clean them up.
    app.get("/projects/:id/share-links", async (req): Promise<ShareLinkDto[]> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(projectParams, req.params);
      await requireAction(prisma, projectId, user.id, "share:manage");
      const links = await prisma.shareLink.findMany({
        where: { projectId, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      return links.map(toDto);
    });

    // Revoke: the link stops working and its pending requests are declined.
    // People who already joined keep their access.
    app.delete("/projects/:id/share-links/:linkId", async (req, reply) => {
      const user = await ctx.user(req);
      const { id: projectId, linkId } = ctx.parse(linkParams, req.params);
      await requireAction(prisma, projectId, user.id, "share:manage");
      const now = new Date();
      // Scoped by projectId so an owner can't revoke another project's link by guessing ids.
      const { count } = await prisma.shareLink.updateMany({
        where: { id: linkId, projectId, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count === 0) {
        const exists = await prisma.shareLink.findFirst({ where: { id: linkId, projectId }, select: { id: true } });
        if (!exists) throw notFound("Link not found"); // already-revoked links stay a no-op success
      } else {
        await prisma.joinRequest.updateMany({
          where: { shareLinkId: linkId, status: "PENDING" },
          data: { status: "DENIED", decidedById: user.id, decidedAt: now },
        });
      }
      return reply.code(204).send();
    });

    // ---------- owner: approve or reject join requests (invite-only links) ----------

    app.get("/projects/:id/join-requests", async (req): Promise<JoinRequestDto[]> => {
      const user = await ctx.user(req);
      const { id: projectId } = ctx.parse(projectParams, req.params);
      await requireAction(prisma, projectId, user.id, "share:manage");
      const rows = await prisma.joinRequest.findMany({
        where: { status: "PENDING", shareLink: { projectId, revokedAt: null } },
        include: { shareLink: { select: { role: true } } },
        orderBy: { createdAt: "asc" },
      });
      const users = await prisma.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, name: true, isGuest: true },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      return rows.flatMap((r) => {
        const u = byId.get(r.userId);
        return u ? [{ id: r.id, role: r.shareLink.role, requester: u, createdAt: r.createdAt.toISOString() }] : [];
      });
    });

    for (const [action, run] of [
      ["approve", approveJoinRequest],
      ["reject", rejectJoinRequest],
    ] as const) {
      app.post(`/projects/:id/join-requests/:requestId/${action}`, async (req, reply) => {
        const user = await ctx.user(req);
        const { id: projectId, requestId } = ctx.parse(requestParams, req.params);
        await requireAction(prisma, projectId, user.id, "share:manage");
        await run(prisma, projectId, requestId, user.id);
        return reply.code(204).send();
      });
    }

    // ---------- anyone holding a link ----------

    // What is behind this link? Lets the page show "expired" or "join as editor" before asking for a name.
    // POST (not GET) so the secret never appears in URLs or access logs.
    app.post(
      "/share-links/preview",
      {
        // Keyed by LINK, not by caller: the web server makes this call on visitors' behalf, so an
        // IP key would be shared by everyone. (Tokens are 256-bit, so guessing is not a concern.)
        config: {
          rateLimit: {
            max: 120,
            timeWindow: "1 minute",
            hook: "preHandler", // the token is in the body, which is only parsed by then
            keyGenerator: (req: { body?: unknown }) =>
              `preview:${hashShareToken(String((req.body as { token?: unknown } | undefined)?.token ?? ""))}`,
          },
        },
      },
      async (req): Promise<LinkPreview> => {
        const { token } = ctx.parse(previewShareLinkInput, req.body);
        return previewShareLink(prisma, token);
      },
    );

    // A signed-in user (or a guest who already has a cookie) opens a link.
    app.post(
      "/share-links/join",
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req): Promise<JoinResult> => {
        const user = await ctx.user(req);
        const { token } = ctx.parse(joinShareLinkInput, req.body);
        return joinViaLink(prisma, await loadUsableLink(prisma, token), user);
      },
    );

    // Someone WITHOUT an account opens a link: a display name is all we ask for.
    // They become a guest with the link's role (never more), identified by a cookie.
    app.post(
      "/share-links/join-guest",
      // Anonymous endpoint that creates rows. Per client IP; sized so a whole class on one campus
      // network can join through the same link. The real caps are per project (guests) and per link
      // (pending requests).
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (req, reply): Promise<JoinResult> => {
        const { token, displayName } = ctx.parse(joinAsGuestInput, req.body);

        // Validate the link BEFORE creating anything, so bad/expired links leave no guest rows behind.
        const link = await loadUsableLink(prisma, token);

        // Already signed in (account or earlier guest cookie)? Then it's just a normal join.
        const existing = await ctx.user(req).catch(() => null);
        if (existing) return joinViaLink(prisma, link, existing);

        await assertGuestRoom(prisma, link);
        const guest = await createGuest(prisma, displayName);
        try {
          const result = await joinViaLink(prisma, link, guest.user);
          setGuestCookie(reply, ctx.secureCookies, guest.token, guest.expires);
          return result;
        } catch (err) {
          await prisma.user.delete({ where: { id: guest.user.id } }); // don't leave an orphan guest
          throw err;
        }
      },
    );
  };

function toDto(l: {
  id: string;
  role: ShareLinkDto["role"];
  createdAt: Date;
  expiresAt: Date | null;
  requiresApproval: boolean;
}): ShareLinkDto {
  return {
    id: l.id,
    role: l.role,
    createdAt: l.createdAt.toISOString(),
    expiresAt: l.expiresAt?.toISOString() ?? null,
    requiresApproval: l.requiresApproval,
  };
}

function setGuestCookie(reply: FastifyReply, secure: boolean, token: string, expires: Date) {
  reply.setCookie(GUEST_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", secure, expires });
}
