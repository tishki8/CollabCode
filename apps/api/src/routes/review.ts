// Suggestions and inline comments.
//
// Both are anchored to text with Yjs RelativePositions (see packages/shared/src/review/anchors.ts),
// stored as opaque bytes and resolved against the LIVE document by the collab server, so they stay on
// the same characters while people edit around them. Suggestions live outside the document (an
// overlay): the text only changes when an editor accepts one.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  base64ToBytes,
  can,
  createCommentInput,
  createSuggestionInput,
  createThreadInput,
  type Anchors,
  type SuggestionDto,
  type ThreadDto,
} from "@collabcode/shared";
import type { Ctx } from "../app";
import { requireAction, getMemberRole } from "../services/access";
import type { CollabClient } from "../services/collab";
import { suggestionDtos, threadDtos } from "../services/review-dto";
import { HttpError, forbidden, notFound } from "../errors";

const id = z.string().min(1).max(64);
const idParams = z.object({ id });
const MAX_ORIGINAL_TEXT = 50_000;
const MAX_QUOTE = 500;
const MAX_OPEN_SUGGESTIONS_PER_FILE = 200;
const MAX_THREADS_PER_FILE = 500;
const MAX_COMMENTS_PER_THREAD = 200;

const toBytes = (b64: string) => new Uint8Array(base64ToBytes(b64));

export const reviewRoutes =
  (ctx: Ctx, collab: CollabClient): FastifyPluginAsync =>
  async (app) => {
    const { prisma } = ctx;

    /** A live file, and the caller's permission on its project. */
    async function fileFor(userId: string, fileId: string, action: Parameters<typeof requireAction>[3]) {
      const node = await prisma.fileNode.findFirst({ where: { id: fileId, type: "FILE", deletedAt: null } });
      if (!node) throw notFound("File not found");
      const role = await requireAction(prisma, node.projectId, userId, action);
      return { node, role };
    }

    /** Where a client-supplied anchor points right now (400 if it points nowhere in this file). */
    async function resolveOrFail(fileId: string, anchors: Anchors) {
      const r = await collab.resolve(fileId, anchors);
      if (r.status !== "ok") throw new HttpError(400, "Those positions are not part of this file");
      return r;
    }

    // ───────────── suggestions ─────────────

    app.get("/files/:id/suggestions", async (req): Promise<SuggestionDto[]> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      const q = ctx.parse(z.object({ status: z.enum(["open", "all"]).default("all") }), req.query);
      const { node } = await fileFor(user.id, fileId, "file:read");
      const rows = await prisma.suggestion.findMany({
        where: { fileId, ...(q.status === "open" ? { status: "OPEN" } : {}) },
        orderBy: { createdAt: "desc" },
        take: 300,
      });
      return suggestionDtos(prisma, node.projectId, rows);
    });

    app.post("/files/:id/suggestions", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(createSuggestionInput, req.body);
      const { node } = await fileFor(user.id, fileId, "suggestion:create");

      if ((await prisma.suggestion.count({ where: { fileId, status: "OPEN" } })) >= MAX_OPEN_SUGGESTIONS_PER_FILE) {
        throw new HttpError(400, `A file can have at most ${MAX_OPEN_SUGGESTIONS_PER_FILE} open suggestions`);
      }
      const at = await resolveOrFail(fileId, input.anchors);
      if (!input.anchors.collapsed && at.gone) throw new HttpError(400, "The text you selected no longer exists");
      if (at.text.length > MAX_ORIGINAL_TEXT) throw new HttpError(400, "Select a smaller piece of text");
      if (at.text === input.newText) throw new HttpError(400, "That suggestion would not change anything");

      const row = await prisma.suggestion.create({
        data: {
          fileId,
          authorId: user.id,
          startAnchor: toBytes(input.anchors.start),
          endAnchor: toBytes(input.anchors.end),
          originalText: at.text,
          newText: input.newText,
        },
      });
      return reply.code(201).send((await suggestionDtos(prisma, node.projectId, [row]))[0]);
    });

    async function loadSuggestion(suggestionId: string) {
      const s = await prisma.suggestion.findUnique({ where: { id: suggestionId } });
      if (!s) throw notFound("Suggestion not found");
      const node = await prisma.fileNode.findFirst({ where: { id: s.fileId, type: "FILE", deletedAt: null } });
      if (!node) throw notFound("Suggestion not found");
      return { s, node };
    }

    // Accepting is an EDIT, applied by the collab server as a normal edit credited to the suggester.
    app.post("/suggestions/:id/accept", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req): Promise<SuggestionDto> => {
      const user = await ctx.user(req);
      const { id: suggestionId } = ctx.parse(idParams, req.params);
      const { s, node } = await loadSuggestion(suggestionId);
      await requireAction(prisma, node.projectId, user.id, "suggestion:resolve");
      // Four eyes: nobody approves their own suggestion (not even the owner). They can withdraw it.
      if (s.authorId === user.id) {
        throw new HttpError(403, "You can't accept your own suggestion. Another editor or the owner has to accept it; you can withdraw it.", undefined, "SELF_ACCEPT");
      }

      // Claim it first so two editors clicking Accept at once cannot apply it twice.
      const claimed = await prisma.suggestion.updateMany({
        where: { id: s.id, status: "OPEN" },
        data: { status: "ACCEPTED", resolvedById: user.id, resolvedAt: new Date() },
      });
      if (claimed.count === 0) throw new HttpError(409, "This suggestion was already handled", undefined, "SUGGESTION_RESOLVED");

      const revert = () => prisma.suggestion.update({ where: { id: s.id }, data: { status: "OPEN", resolvedById: null, resolvedAt: null } });
      let result;
      try {
        result = await collab.edit({
          fileId: s.fileId,
          userId: s.authorId, // credited to the person who suggested it
          origin: "suggestion-accept",
          op: {
            type: "replace-range",
            anchors: { start: Buffer.from(s.startAnchor).toString("base64"), end: Buffer.from(s.endAnchor).toString("base64"), collapsed: Buffer.compare(Buffer.from(s.startAnchor), Buffer.from(s.endAnchor)) === 0 },
            newText: s.newText,
          },
        });
      } catch (err) {
        await revert();
        throw err;
      }
      if (result.status === "stale") {
        await prisma.suggestion.update({ where: { id: s.id }, data: { status: "STALE", resolvedById: null, resolvedAt: new Date() } });
        throw new HttpError(409, "The text this suggestion was about has been deleted", undefined, "SUGGESTION_STALE");
      }
      const row = await prisma.suggestion.findUniqueOrThrow({ where: { id: s.id } });
      return (await suggestionDtos(prisma, node.projectId, [row]))[0]!;
    });

    // Editors and the owner can reject; the author can withdraw their own.
    app.post("/suggestions/:id/reject", async (req): Promise<SuggestionDto> => {
      const user = await ctx.user(req);
      const { id: suggestionId } = ctx.parse(idParams, req.params);
      const { s, node } = await loadSuggestion(suggestionId);
      const role = await getMemberRole(prisma, node.projectId, user.id);
      if (!role) throw notFound("Suggestion not found");
      if (!can(role, "suggestion:resolve") && s.authorId !== user.id) throw forbidden();
      const done = await prisma.suggestion.updateMany({
        where: { id: s.id, status: "OPEN" },
        data: { status: "REJECTED", resolvedById: user.id, resolvedAt: new Date() },
      });
      if (done.count === 0) throw new HttpError(409, "This suggestion was already handled", undefined, "SUGGESTION_RESOLVED");
      const row = await prisma.suggestion.findUniqueOrThrow({ where: { id: s.id } });
      return (await suggestionDtos(prisma, node.projectId, [row]))[0]!;
    });

    // ───────────── comment threads ─────────────

    app.get("/files/:id/threads", async (req): Promise<ThreadDto[]> => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      const { node } = await fileFor(user.id, fileId, "file:read");
      const rows = await prisma.commentThread.findMany({
        where: { fileId },
        include: { comments: true },
        orderBy: { createdAt: "asc" },
        take: MAX_THREADS_PER_FILE,
      });
      return threadDtos(prisma, node.projectId, rows);
    });

    app.post("/files/:id/threads", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
      const user = await ctx.user(req);
      const { id: fileId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(createThreadInput, req.body);
      const { node } = await fileFor(user.id, fileId, "comment:create");
      if ((await prisma.commentThread.count({ where: { fileId } })) >= MAX_THREADS_PER_FILE) {
        throw new HttpError(400, `A file can have at most ${MAX_THREADS_PER_FILE} comment threads`);
      }
      const at = await resolveOrFail(fileId, input.anchors);
      if (!input.anchors.collapsed && at.gone) throw new HttpError(400, "The text you selected no longer exists");
      const row = await prisma.commentThread.create({
        data: {
          fileId,
          startAnchor: toBytes(input.anchors.start),
          endAnchor: toBytes(input.anchors.end),
          quote: at.text.slice(0, MAX_QUOTE),
          createdById: user.id,
          comments: { create: { authorId: user.id, body: input.body } },
        },
        include: { comments: true },
      });
      return reply.code(201).send((await threadDtos(prisma, node.projectId, [row]))[0]);
    });

    async function loadThread(threadId: string) {
      const t = await prisma.commentThread.findUnique({ where: { id: threadId } });
      if (!t) throw notFound("Thread not found");
      const node = await prisma.fileNode.findFirst({ where: { id: t.fileId, type: "FILE", deletedAt: null } });
      if (!node) throw notFound("Thread not found");
      return { t, node };
    }
    const threadOf = async (threadId: string, projectId: string): Promise<ThreadDto> => {
      const row = await prisma.commentThread.findUniqueOrThrow({ where: { id: threadId }, include: { comments: true } });
      return (await threadDtos(prisma, projectId, [row]))[0]!;
    };

    app.post("/threads/:id/comments", { config: { rateLimit: { max: 90, timeWindow: "1 minute" } } }, async (req, reply): Promise<ThreadDto> => {
      const user = await ctx.user(req);
      const { id: threadId } = ctx.parse(idParams, req.params);
      const input = ctx.parse(createCommentInput, req.body);
      const { t, node } = await loadThread(threadId);
      await requireAction(prisma, node.projectId, user.id, "comment:create");
      if ((await prisma.comment.count({ where: { threadId } })) >= MAX_COMMENTS_PER_THREAD) {
        throw new HttpError(400, `A thread can have at most ${MAX_COMMENTS_PER_THREAD} comments`);
      }
      await prisma.comment.create({ data: { threadId: t.id, authorId: user.id, body: input.body } });
      reply.code(201);
      return threadOf(t.id, node.projectId);
    });

    // Resolve / reopen: editors and the owner, or the person who started the thread.
    for (const [path, resolved] of [["resolve", true], ["reopen", false]] as const) {
      app.post(`/threads/:id/${path}`, async (req): Promise<ThreadDto> => {
        const user = await ctx.user(req);
        const { id: threadId } = ctx.parse(idParams, req.params);
        const { t, node } = await loadThread(threadId);
        const role = await getMemberRole(prisma, node.projectId, user.id);
        if (!role) throw notFound("Thread not found");
        if (!can(role, "comment:resolve") && !(t.createdById === user.id && can(role, "comment:create"))) throw forbidden();
        await prisma.commentThread.update({
          where: { id: t.id },
          data: resolved ? { resolvedAt: new Date(), resolvedById: user.id } : { resolvedAt: null, resolvedById: null },
        });
        return threadOf(t.id, node.projectId);
      });
    }
  };
