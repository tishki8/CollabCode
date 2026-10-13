// Internal HTTP endpoints, called by the API (never by browsers), signed with the shared secret:
//
//   POST /internal/resolve  where do these anchors point right now, and what text is there?
//   POST /internal/edit     change a document as a given user: accept a suggestion (credited to the
//                           suggester) or restore a version (credited to the restorer)
//   POST /internal/flush    write buffered authorship events and the document snapshot to the database,
//                           so a checkpoint reads state that includes every edit up to now
//
// An edit is built on a scratch copy of the live document under a fresh clientID, then goes through the
// SAME authorship path as a typed edit (`tracker.onDelivery`) before it is applied and broadcast. So
// it is recorded in the event log for the user it is credited to, with an origin that says why.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import * as Y from "yjs";
import type { Hocuspocus } from "@hocuspocus/server";
import { anchorsInput, isGone, minimalReplacement, resolveAnchors } from "@collabcode/shared";
import { verifyInternal } from "@collabcode/shared/internal-auth";
import type { AuthorshipTracker } from "./authorship/tracker";

const MAX_BODY = 8 * 1024 * 1024;

const idSchema = z.string().min(1).max(64);
const resolveBody = z.object({ fileId: idSchema, anchors: anchorsInput });
const flushBody = z.object({ fileIds: z.array(idSchema).max(1000) });
const editBody = z.object({
  fileId: idSchema,
  /** Who the edit is credited to. */
  userId: idSchema,
  origin: z.enum(["suggestion-accept", "restore"]),
  op: z.discriminatedUnion("type", [
    z.object({ type: z.literal("replace-range"), anchors: anchorsInput, newText: z.string().max(1_000_000) }),
    z.object({ type: z.literal("set-text"), text: z.string().max(5_000_000) }),
  ]),
});

export type EditResult =
  | { status: "applied"; from: number; to: number; replaced: string }
  | { status: "unchanged" }
  | { status: "stale" };

const randomClientId = () => {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return n === 0 ? 1 : n;
};

/** The update that `change` makes to `live`, built on a scratch copy under a fresh clientID. */
function buildUpdate(live: Y.Doc, change: (text: Y.Text) => void): Uint8Array | null {
  const scratch = new Y.Doc();
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(live));
  scratch.clientID = randomClientId(); // set after syncing: Yjs would otherwise swap an id it sees in use
  const captured: Uint8Array[] = [];
  scratch.on("update", (u: Uint8Array) => captured.push(u));
  scratch.transact(() => change(scratch.getText("content")));
  scratch.destroy();
  return captured.length ? Y.mergeUpdates(captured) : null;
}

export interface InternalDeps {
  secret: string;
  tracker: AuthorshipTracker;
}

export function createInternalHandler(deps: InternalDeps) {
  const { tracker } = deps;

  async function withDocument<T>(hp: Hocuspocus, fileId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T> {
    const conn = await hp.openDirectConnection(`file:${fileId}`, { internal: true });
    try {
      return await fn(conn.document as unknown as Y.Doc);
    } finally {
      await conn.disconnect(); // stores the snapshot right away; the document stays loaded if anyone else is connected
    }
  }

  async function edit(hp: Hocuspocus, body: z.infer<typeof editBody>): Promise<EditResult> {
    const { fileId, userId, origin, op } = body;
    return withDocument(hp, fileId, async (live) => {
      const liveText = live.getText("content");
      let result: EditResult;
      let update: Uint8Array | null;

      if (op.type === "replace-range") {
        const range = resolveAnchors(Y, live, liveText, op.anchors);
        if (isGone(op.anchors, range)) return { status: "stale" };
        const { from, to } = range!;
        const replaced = liveText.toString().slice(from, to);
        result = { status: "applied", from, to, replaced };
        update = buildUpdate(live, (t) => {
          if (to > from) t.delete(from, to - from);
          if (op.newText.length > 0) t.insert(from, op.newText);
        });
      } else {
        const current = liveText.toString();
        const r = minimalReplacement(current, op.text);
        if (!r) return { status: "unchanged" };
        result = { status: "applied", from: r.from, to: r.from + r.deleteCount, replaced: current.slice(r.from, r.from + r.deleteCount) };
        update = buildUpdate(live, (t) => {
          if (r.deleteCount > 0) t.delete(r.from, r.deleteCount);
          if (r.insert.length > 0) t.insert(r.from, r.insert);
        });
      }
      if (!update) return { status: "unchanged" };

      // Same path as a typed edit: attribute at delivery (BEFORE applying), then apply and broadcast.
      await tracker.onDelivery(fileId, live, userId, update, { origin });
      Y.applyUpdate(live, update, { source: "local", context: { internal: true } });
      await tracker.flushDocument(fileId);
      return result;
    });
  }

  async function dispatch(hp: Hocuspocus, path: string, raw: unknown): Promise<unknown> {
    if (path === "/internal/resolve") {
      const body = resolveBody.parse(raw);
      return withDocument(hp, body.fileId, async (live) => {
        const text = live.getText("content");
        const range = resolveAnchors(Y, live, text, body.anchors);
        if (!range) return { status: "invalid" };
        return { status: "ok", from: range.from, to: range.to, text: text.toString().slice(range.from, range.to), gone: isGone(body.anchors, range) };
      });
    }
    if (path === "/internal/flush") {
      const body = flushBody.parse(raw);
      for (const fileId of body.fileIds) {
        await withDocument(hp, fileId, async () => {
          await tracker.flushDocument(fileId);
        });
      }
      return { status: "ok" };
    }
    if (path === "/internal/edit") return edit(hp, editBody.parse(raw));
    return undefined;
  }

  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  /** Returns true when the request was an /internal one (and has been answered). */
  return async function handle(hp: Hocuspocus, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url?.split("?")[0] ?? "";
    if (!path.startsWith("/internal/")) return false;
    if (req.method !== "POST") {
      reply(res, 405, { error: "POST only" });
      return true;
    }
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      reply(res, 413, { error: "Body too large" });
      return true;
    }
    const ts = req.headers["x-internal-timestamp"];
    const sig = req.headers["x-internal-signature"];
    if (!verifyInternal(deps.secret, body, typeof ts === "string" ? ts : undefined, typeof sig === "string" ? sig : undefined)) {
      reply(res, 401, { error: "Unauthorized" });
      return true;
    }
    try {
      const out = await dispatch(hp, path, JSON.parse(body));
      if (out === undefined) reply(res, 404, { error: "Unknown endpoint" });
      else reply(res, 200, out);
    } catch (err) {
      if (err instanceof z.ZodError || err instanceof SyntaxError) reply(res, 400, { error: "Invalid request" });
      else {
        console.error("[collab] internal request failed", path, err);
        reply(res, 500, { error: "Internal error" });
      }
    }
    return true;
  };
}
