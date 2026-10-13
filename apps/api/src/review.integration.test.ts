// Suggestions, comments, checkpoints and replay data against a real Postgres, with an in-memory
// stand-in for the collab server (the real one is covered by apps/collab/src/review.integration.test.ts
// and the Playwright tests).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { PrismaClient } from "@collabcode/db";
import { createAnchors, isGone, minimalReplacement, resolveAnchors, type Anchors } from "@collabcode/shared";
import { buildApp } from "./app";
import type { CollabClient, EditRequest } from "./services/collab";

const WEB = "http://localhost:3000";
const run = describe.skipIf(!process.env.DATABASE_URL);

run("review tools (integration)", () => {
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const userIds: string[] = [];
  let projectId = "";
  let fileId = "";
  let otherFileId = "";

  /** A collab server in memory: live documents, the same anchor resolution, and a record of every edit. */
  const docs = new Map<string, Y.Doc>();
  const edits: EditRequest[] = [];
  const doc = (id: string) => {
    let d = docs.get(id);
    if (!d) docs.set(id, (d = new Y.Doc()));
    return d;
  };
  const text = (id: string) => doc(id).getText("content");
  const fake: CollabClient = {
    async resolve(id, anchors: Anchors) {
      const d = doc(id);
      const r = resolveAnchors(Y, d, d.getText("content"), anchors);
      if (!r) return { status: "invalid" };
      return { status: "ok", from: r.from, to: r.to, text: d.getText("content").toString().slice(r.from, r.to), gone: isGone(anchors, r) };
    },
    async edit(req) {
      edits.push(req);
      const d = doc(req.fileId);
      const t = d.getText("content");
      if (req.op.type === "replace-range") {
        const r = resolveAnchors(Y, d, t, req.op.anchors);
        if (isGone(req.op.anchors, r)) return { status: "stale" };
        const replaced = t.toString().slice(r!.from, r!.to);
        if (r!.to > r!.from) t.delete(r!.from, r!.to - r!.from);
        t.insert(r!.from, req.op.newText);
        return { status: "applied", from: r!.from, to: r!.to, replaced };
      }
      const rep = minimalReplacement(t.toString(), req.op.text);
      if (!rep) return { status: "unchanged" };
      const replaced = t.toString().slice(rep.from, rep.from + rep.deleteCount);
      if (rep.deleteCount) t.delete(rep.from, rep.deleteCount);
      if (rep.insert) t.insert(rep.from, rep.insert);
      return { status: "applied", from: rep.from, to: rep.from + rep.deleteCount, replaced };
    },
    async flush(fileIds) {
      for (const f of fileIds) {
        const state = Buffer.from(Y.encodeStateAsUpdate(doc(f)));
        await prisma.docSnapshot.upsert({ where: { fileId: f }, update: { state }, create: { fileId: f, state } });
      }
    },
  };

  async function makeUser(key: string) {
    const token = randomUUID();
    const u = await prisma.user.create({
      data: { name: `Rv ${key}`, email: `${randomUUID()}@test.local`, sessions: { create: { sessionToken: token, expires: new Date(Date.now() + 3_600_000) } } },
    });
    userIds.push(u.id);
    cookies[key] = `authjs.session-token=${token}`;
    ids[key] = u.id;
  }
  const call = (who: string | null, method: "GET" | "POST", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    app.inject({ method, url, payload: payload as object | undefined, headers: { ...(who ? { cookie: cookies[who]! } : {}), origin: WEB, ...extra } });

  const anchorsFor = (id: string, needle: string): Anchors => {
    const at = text(id).toString().indexOf(needle);
    return createAnchors(Y, text(id), at, at + needle.length);
  };

  beforeAll(async () => {
    app = await buildApp({ prisma, webOrigin: WEB, collabSecret: "x".repeat(32), collabPublicUrl: "ws://x", collab: fake });
    await Promise.all(["owner", "editor", "commenter", "commenter2", "viewer", "outsider"].map(makeUser));
    projectId = (await prisma.project.create({ data: { name: "review", language: "PYTHON", ownerId: ids.owner! } })).id;
    const roles = { owner: "OWNER", editor: "EDITOR", commenter: "COMMENTER", commenter2: "COMMENTER", viewer: "VIEWER" } as const;
    await prisma.projectMember.createMany({
      data: Object.entries(roles).map(([k, role], i) => ({ projectId, userId: ids[k]!, role, color: `#00000${i}`, initials: k.slice(0, 2).toUpperCase() })),
    });
    fileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "main.py", type: "FILE" } })).id;
    otherFileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "util.py", type: "FILE" } })).id;
    text(fileId).insert(0, "def main():\n    print('hello world')\n");
    text(otherFileId).insert(0, "X = 1\n");
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.suggestion.deleteMany({ where: { fileId: { in: [fileId, otherFileId] } } });
    await prisma.commentThread.deleteMany({ where: { fileId: { in: [fileId, otherFileId] } } });
    await prisma.docEvent.deleteMany({ where: { fileId: { in: [fileId, otherFileId] } } });
    await prisma.docSnapshot.deleteMany({ where: { fileId: { in: [fileId, otherFileId] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
    await app.close();
  });

  describe("suggestions", () => {
    const suggest = (who: string, needle = "hello world", newText = "hi there") =>
      call(who, "POST", `/files/${fileId}/suggestions`, { anchors: anchorsFor(fileId, needle), newText });

    it("commenters and editors can suggest; viewers cannot; outsiders do not even see the file", async () => {
      const ok = await suggest("commenter");
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ status: "OPEN", originalText: "hello world", newText: "hi there", author: { id: ids.commenter } });
      expect((await suggest("editor")).statusCode).toBe(201);
      expect((await suggest("viewer")).statusCode).toBe(403);
      expect((await suggest("outsider")).statusCode).toBe(404);
      expect((await call(null, "POST", `/files/${fileId}/suggestions`, {})).statusCode).toBe(401);
    });

    it("validates input: no-op suggestions, garbage anchors, oversize text", async () => {
      expect((await suggest("commenter", "hello world", "hello world")).statusCode).toBe(400);
      expect((await call("commenter", "POST", `/files/${fileId}/suggestions`, { anchors: { start: "AAAA", end: "AAAA", collapsed: false }, newText: "x" })).statusCode).toBe(400);
      expect((await call("commenter", "POST", `/files/${fileId}/suggestions`, { anchors: anchorsFor(fileId, "main"), newText: "x".repeat(20_001) })).statusCode).toBe(400);
    });

    it("only editors and the owner can accept: commenters and viewers get 403", async () => {
      const s = (await suggest("commenter", "main", "start")).json();
      expect((await call("commenter", "POST", `/suggestions/${s.id}/accept`)).statusCode).toBe(403);
      expect((await call("viewer", "POST", `/suggestions/${s.id}/accept`)).statusCode).toBe(403);
      expect((await call("outsider", "POST", `/suggestions/${s.id}/accept`)).statusCode).toBe(404);
      expect(text(fileId).toString()).toContain("def main");
      const row = await prisma.suggestion.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.status).toBe("OPEN");
    });

    it("accepting applies the edit CREDITED TO THE SUGGESTER (origin suggestion-accept), even though the editor clicked", async () => {
      const s = (await suggest("commenter", "hello world", "hi there")).json();
      edits.length = 0;
      const res = await call("editor", "POST", `/suggestions/${s.id}/accept`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ACCEPTED", resolvedBy: { id: ids.editor } });
      expect(text(fileId).toString()).toContain("print('hi there')");
      expect(edits).toHaveLength(1);
      expect(edits[0]).toMatchObject({ fileId, userId: ids.commenter, origin: "suggestion-accept" });
      // a second click (or a second editor) cannot apply it again
      expect((await call("owner", "POST", `/suggestions/${s.id}/accept`)).statusCode).toBe(409);
      expect((await call("owner", "POST", `/suggestions/${s.id}/reject`)).statusCode).toBe(409);
      expect(edits).toHaveLength(1);
    });

    it("nobody can accept their own suggestion, not even the owner: the server says 403 SELF_ACCEPT and the text is untouched", async () => {
      for (const who of ["owner", "editor"]) {
        const s = (await suggest(who, "main", "start")).json();
        edits.length = 0;
        const res = await call(who, "POST", `/suggestions/${s.id}/accept`);
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("SELF_ACCEPT");
        expect(edits).toHaveLength(0);
        expect(text(fileId).toString()).toContain("def main");
        expect((await prisma.suggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("OPEN");

        // they can withdraw it
        expect((await call(who, "POST", `/suggestions/${s.id}/reject`)).json()).toMatchObject({ status: "REJECTED", resolvedBy: { id: ids[who] } });
      }
    });

    it("another editor (or the owner) CAN accept an editor's or owner's suggestion, credited to its author", async () => {
      text(fileId).insert(text(fileId).length, "zz_alpha = 1\n");
      const fromOwner = (await suggest("owner", "zz_alpha", "zz_beta")).json();
      edits.length = 0;
      expect((await call("editor", "POST", `/suggestions/${fromOwner.id}/accept`)).statusCode).toBe(200);
      expect(edits[0]).toMatchObject({ userId: ids.owner, origin: "suggestion-accept" });
      expect(text(fileId).toString()).toContain("zz_beta = 1");

      const fromEditor = (await suggest("editor", "zz_beta", "zz_gamma")).json();
      expect((await call("owner", "POST", `/suggestions/${fromEditor.id}/accept`)).statusCode).toBe(200);
      expect(edits.at(-1)).toMatchObject({ userId: ids.editor });
      expect(text(fileId).toString()).toContain("zz_gamma = 1");
    });

    it("rejecting: the owner and editors can; the author can withdraw their own; other commenters cannot", async () => {
      const s1 = (await suggest("commenter", "main", "begin")).json();
      expect((await call("commenter2", "POST", `/suggestions/${s1.id}/reject`)).statusCode).toBe(403);
      expect((await call("viewer", "POST", `/suggestions/${s1.id}/reject`)).statusCode).toBe(403);
      const withdrawn = await call("commenter", "POST", `/suggestions/${s1.id}/reject`);
      expect(withdrawn.json()).toMatchObject({ status: "REJECTED", resolvedBy: { id: ids.commenter } });

      const s2 = (await suggest("commenter", "main", "begin")).json();
      expect((await call("owner", "POST", `/suggestions/${s2.id}/reject`)).json().status).toBe("REJECTED");
      const s3 = (await suggest("commenter", "main", "begin")).json();
      expect((await call("editor", "POST", `/suggestions/${s3.id}/reject`)).json().status).toBe("REJECTED");
      expect(text(fileId).toString()).toContain("def main"); // rejecting never changes the text
    });

    it("a suggestion whose text has been deleted goes stale on accept and changes nothing", async () => {
      const s = (await suggest("commenter", "def main():", "def start():")).json();
      const t = text(fileId);
      t.delete(t.toString().indexOf("def main():"), "def main():".length);
      const res = await call("editor", "POST", `/suggestions/${s.id}/accept`);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("SUGGESTION_STALE");
      expect(text(fileId).toString()).not.toContain("def start");
      expect((await prisma.suggestion.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("STALE");
      t.insert(0, "def main():"); // put it back for the remaining tests
    });

    it("a suggestion stays attached to its text while someone edits above it", async () => {
      const s = (await suggest("commenter", "print", "echo")).json();
      text(fileId).insert(0, "# a\n# b\n# c\n");
      expect((await call("owner", "POST", `/suggestions/${s.id}/accept`)).statusCode).toBe(200);
      expect(text(fileId).toString()).toContain("echo('hi there')");
      expect(text(fileId).toString().startsWith("# a\n# b\n# c\n")).toBe(true);
    });

    it("lists suggestions with authors, filterable by status", async () => {
      const all = (await call("viewer", "GET", `/files/${fileId}/suggestions`)).json();
      const open = (await call("viewer", "GET", `/files/${fileId}/suggestions?status=open`)).json();
      expect(all.length).toBeGreaterThan(open.length);
      expect(open.every((s: { status: string }) => s.status === "OPEN")).toBe(true);
      expect(all[0].author.name).toMatch(/Rv /);
      expect((await call("outsider", "GET", `/files/${fileId}/suggestions`)).statusCode).toBe(404);
    });

    it("an insertion (nothing selected) can be suggested and accepted", async () => {
      const at = text(fileId).toString().indexOf("\n");
      const anchors = createAnchors(Y, text(fileId), at, at);
      const s = (await call("commenter", "POST", `/files/${fileId}/suggestions`, { anchors, newText: "  # inserted" })).json();
      expect(s).toMatchObject({ originalText: "", anchors: { collapsed: true } });
      expect((await call("editor", "POST", `/suggestions/${s.id}/accept`)).statusCode).toBe(200);
      expect(text(fileId).toString()).toContain("  # inserted\n");
    });
  });

  describe("who is acting (identity)", () => {
    it("the author always comes from the session cookie, never from the request body or the project owner", async () => {
      const t = await call("commenter", "POST", `/files/${fileId}/threads`, { anchors: anchorsFor(fileId, "main"), body: "hi", authorId: ids.owner, createdById: ids.owner });
      expect(t.statusCode).toBe(201);
      expect(t.json().createdBy.id).toBe(ids.commenter);
      expect(t.json().comments[0].author.id).toBe(ids.commenter);
      const reply = await call("commenter2", "POST", `/threads/${t.json().id}/comments`, { body: "yo", authorId: ids.owner });
      expect(reply.json().comments.at(-1).author.id).toBe(ids.commenter2);
      const sg = await call("commenter2", "POST", `/files/${fileId}/suggestions`, { anchors: anchorsFor(fileId, "main"), newText: "primary", authorId: ids.owner });
      expect(sg.json().author.id).toBe(ids.commenter2);
      const done = await call("editor", "POST", `/threads/${t.json().id}/resolve`);
      expect(done.json().resolvedBy.id).toBe(ids.editor);
      expect((await call("editor", "POST", `/suggestions/${sg.json().id}/reject`)).json().resolvedBy.id).toBe(ids.editor);
      // and the rows in the database agree
      const rows = await prisma.comment.findMany({ where: { threadId: t.json().id } });
      expect(rows.map((r) => r.authorId).sort()).toEqual([ids.commenter, ids.commenter2].sort());
    });

    it("a page that thinks it is Bob but whose cookie is now Alice's is refused (409 IDENTITY_CHANGED), and nothing is written", async () => {
      const before = await prisma.commentThread.count({ where: { fileId } });
      // the cookie is the owner's; the page was opened as the commenter
      const res = await call("owner", "POST", `/files/${fileId}/threads`, { anchors: anchorsFor(fileId, "main"), body: "I am bob" }, { "x-expected-user": ids.commenter! });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: "IDENTITY_CHANGED", details: { signedInAs: { id: ids.owner } } });
      expect(await prisma.commentThread.count({ where: { fileId } })).toBe(before);
      // reads are refused too, so the page cannot show the other person's view as if it were Bob's
      expect((await call("owner", "GET", `/files/${fileId}/threads`, undefined, { "x-expected-user": ids.commenter! })).statusCode).toBe(409);
      // a matching header (or none) works
      expect((await call("owner", "GET", `/files/${fileId}/threads`, undefined, { "x-expected-user": ids.owner! })).statusCode).toBe(200);
      expect((await call("owner", "GET", `/files/${fileId}/threads`)).statusCode).toBe(200);
    });
  });

  describe("comments", () => {
    let threadId = "";
    const open = (who: string, needle = "echo", body = "Why echo?") =>
      call(who, "POST", `/files/${fileId}/threads`, { anchors: anchorsFor(fileId, needle), body });

    it("commenters can start a thread; editors can too; viewers cannot", async () => {
      const t = await open("commenter");
      expect(t.statusCode).toBe(201);
      expect(t.json()).toMatchObject({ quote: "echo", resolvedAt: null, createdBy: { id: ids.commenter }, comments: [{ body: "Why echo?", author: { id: ids.commenter } }] });
      threadId = t.json().id;
      expect((await open("editor")).statusCode).toBe(201);
      expect((await open("viewer")).statusCode).toBe(403);
      expect((await open("outsider")).statusCode).toBe(404);
    });

    it("anyone who can comment can reply, in order; viewers cannot", async () => {
      const r1 = await call("editor", "POST", `/threads/${threadId}/comments`, { body: "Because print was renamed." });
      expect(r1.statusCode).toBe(201);
      await call("commenter", "POST", `/threads/${threadId}/comments`, { body: "Thanks!" });
      const thread = (await call("viewer", "GET", `/files/${fileId}/threads`)).json().find((t: { id: string }) => t.id === threadId);
      expect(thread.comments.map((c: { body: string }) => c.body)).toEqual(["Why echo?", "Because print was renamed.", "Thanks!"]);
      expect((await call("viewer", "POST", `/threads/${threadId}/comments`, { body: "me too" })).statusCode).toBe(403);
      expect((await call("commenter", "POST", `/threads/${threadId}/comments`, { body: "   " })).statusCode).toBe(400);
      expect((await call("commenter", "POST", `/threads/${threadId}/comments`, { body: "x".repeat(4001) })).statusCode).toBe(400);
    });

    it("resolve / reopen: editors, owner and the thread's starter can; other commenters and viewers cannot", async () => {
      expect((await call("commenter2", "POST", `/threads/${threadId}/resolve`)).statusCode).toBe(403);
      expect((await call("viewer", "POST", `/threads/${threadId}/resolve`)).statusCode).toBe(403);
      const resolved = await call("editor", "POST", `/threads/${threadId}/resolve`);
      expect(resolved.json()).toMatchObject({ resolvedBy: { id: ids.editor } });
      expect(resolved.json().resolvedAt).not.toBeNull();
      expect((await call("commenter2", "POST", `/threads/${threadId}/reopen`)).statusCode).toBe(403);
      const reopened = await call("commenter", "POST", `/threads/${threadId}/reopen`); // the starter
      expect(reopened.json()).toMatchObject({ resolvedAt: null, resolvedBy: null });
      expect((await call("commenter", "POST", `/threads/${threadId}/resolve`)).statusCode).toBe(200);
    });

    it("a thread stays on its text when lines are added above (anchors are not line numbers)", async () => {
      const t = (await open("commenter", "hi there", "anchored")).json();
      text(fileId).insert(0, "# x\n# y\n");
      const live = (await call("viewer", "GET", `/files/${fileId}/threads`)).json().find((x: { id: string }) => x.id === t.id);
      const r = resolveAnchors(Y, doc(fileId), text(fileId), live.anchors)!;
      expect(text(fileId).toString().slice(r.from, r.to)).toBe("hi there");
    });
  });

  describe("checkpoints", () => {
    let cpId = "";
    let before = { main: "", util: "" };

    it("editors can create one; commenters and viewers cannot; it snapshots every file", async () => {
      expect((await call("commenter", "POST", `/projects/${projectId}/checkpoints`, { name: "x" })).statusCode).toBe(403);
      expect((await call("viewer", "POST", `/projects/${projectId}/checkpoints`, { name: "x" })).statusCode).toBe(403);
      expect((await call("editor", "POST", `/projects/${projectId}/checkpoints`, { name: "   " })).statusCode).toBe(400);
      before = { main: text(fileId).toString(), util: text(otherFileId).toString() };
      const res = await call("editor", "POST", `/projects/${projectId}/checkpoints`, { name: "v1" });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ name: "v1", automatic: false, fileCount: 2, createdBy: { id: ids.editor } });
      cpId = res.json().id;
      const files = await prisma.checkpointFile.findMany({ where: { checkpointId: cpId } });
      const d = new Y.Doc();
      Y.applyUpdate(d, new Uint8Array(files.find((f) => f.fileId === fileId)!.state));
      expect(d.getText("content").toString()).toBe(before.main);
      expect(files.map((f) => f.path).sort()).toEqual(["main.py", "util.py"]);
    });

    it("lists checkpoints for any member; outsiders get 404", async () => {
      const list = (await call("viewer", "GET", `/projects/${projectId}/checkpoints`)).json();
      expect(list.map((c: { name: string }) => c.name)).toContain("v1");
      expect((await call("outsider", "GET", `/projects/${projectId}/checkpoints`)).statusCode).toBe(404);
      const detail = (await call("viewer", "GET", `/checkpoints/${cpId}`)).json();
      expect(detail.files.map((f: { path: string }) => f.path)).toEqual(["main.py", "util.py"]);
    });

    it("only the owner can restore", async () => {
      for (const who of ["editor", "commenter", "viewer"]) expect((await call(who, "POST", `/checkpoints/${cpId}/restore`, {})).statusCode).toBe(403);
      expect((await call("outsider", "POST", `/checkpoints/${cpId}/restore`, {})).statusCode).toBe(404);
    });

    it("restoring one file is an edit credited to the restorer; other files are untouched; a safety checkpoint is made", async () => {
      text(fileId).insert(text(fileId).length, "BROKEN = True\n");
      text(otherFileId).insert(0, "KEEP = 2\n");
      edits.length = 0;
      const res = await call("owner", "POST", `/checkpoints/${cpId}/restore`, { fileId });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ restored: 1, removed: 0, recreated: 0 });
      expect(text(fileId).toString()).toBe(before.main);
      expect(text(otherFileId).toString()).toContain("KEEP = 2");
      expect(edits).toEqual([expect.objectContaining({ fileId, userId: ids.owner, origin: "restore" })]);
      const safety = await prisma.checkpoint.findUniqueOrThrow({ where: { id: res.json().safetyCheckpointId } });
      expect(safety).toMatchObject({ automatic: true });
      expect(safety.name).toMatch(/Before restoring/);
      // the safety checkpoint holds the state from before the restore, so the restore is undoable
      const f = await prisma.checkpointFile.findUniqueOrThrow({ where: { checkpointId_fileId: { checkpointId: safety.id, fileId } } });
      const d = new Y.Doc();
      Y.applyUpdate(d, new Uint8Array(f.state));
      expect(d.getText("content").toString()).toContain("BROKEN = True");
      // restoring again changes nothing
      expect((await call("owner", "POST", `/checkpoints/${cpId}/restore`, { fileId })).json()).toMatchObject({ restored: 0, unchanged: 1 });
    });

    it("restoring the whole project brings back deleted files, removes files created later, and restores every file", async () => {
      await prisma.fileNode.update({ where: { id: otherFileId }, data: { deletedAt: new Date() } });
      const later = await prisma.fileNode.create({ data: { projectId, parentId: null, name: "later.py", type: "FILE" } });
      text(later.id).insert(0, "NEW\n");
      text(fileId).insert(0, "# garbage\n");
      const res = await call("owner", "POST", `/checkpoints/${cpId}/restore`, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ restored: 2, recreated: 1, removed: 1 });
      expect(text(fileId).toString()).toBe(before.main);
      expect(text(otherFileId).toString()).toBe(before.util);
      expect((await prisma.fileNode.findUniqueOrThrow({ where: { id: otherFileId } })).deletedAt).toBeNull();
      expect((await prisma.fileNode.findUniqueOrThrow({ where: { id: later.id } })).deletedAt).not.toBeNull();
      expect(edits.at(-1)).toMatchObject({ userId: ids.owner, origin: "restore" });
      await prisma.docSnapshot.deleteMany({ where: { fileId: later.id } });
    });

    it("a restore that clashes with a file created under the same name keeps both (renames the returning one)", async () => {
      await prisma.fileNode.update({ where: { id: otherFileId }, data: { deletedAt: new Date() } });
      await prisma.fileNode.create({ data: { projectId, parentId: null, name: "util.py", type: "FILE" } });
      const res = await call("owner", "POST", `/checkpoints/${cpId}/restore`, { fileId: otherFileId });
      expect(res.statusCode).toBe(200);
      expect((await prisma.fileNode.findUniqueOrThrow({ where: { id: otherFileId } })).name).toBe("util.py (restored)");
    });

    it("404 for an unknown file in the checkpoint", async () => {
      expect((await call("owner", "POST", `/checkpoints/${cpId}/restore`, { fileId: "nope" })).statusCode).toBe(404);
    });
  });

  describe("replay data", () => {
    const evt = (userId: string, update: Uint8Array, t: number) =>
      prisma.docEvent.create({
        data: { fileId, userId, clientId: BigInt(1), clockStart: 0, clockEnd: 0, update: Buffer.from(update), added: 1, removed: 0, startedAt: new Date(t), createdAt: new Date(t + 10) },
      });

    it("offers the beginning and each checkpoint as starting points, with the events left to play from each", async () => {
      await prisma.docEvent.deleteMany({ where: { fileId } });
      const src = new Y.Doc();
      docs.set(fileId, src); // the "live" document is now the one we are scripting
      const ups: Uint8Array[] = [];
      src.on("update", (u: Uint8Array) => ups.push(u));
      src.getText("content").insert(0, "a");
      src.getText("content").insert(1, "b");
      await evt(ids.owner!, ups[0]!, 1000);
      await evt(ids.editor!, ups[1]!, 2000);
      const cp = (await call("editor", "POST", `/projects/${projectId}/checkpoints`, { name: "mid" })).json();
      src.getText("content").insert(2, "c");
      await evt(ids.owner!, ups[2]!, 3000);

      const points = (await call("viewer", "GET", `/files/${fileId}/replay-points`)).json();
      expect(points[0]).toMatchObject({ checkpointId: null, events: 3 });
      expect(points.find((p: { name: string }) => p.name === "mid")).toMatchObject({ checkpointId: cp.id, events: 1 });

      const full = (await call("viewer", "GET", `/files/${fileId}/replay`)).json();
      expect(full.events).toHaveLength(3);
      expect(full.base.checkpointId).toBeNull();
      expect(full.users.map((u: { id: string }) => u.id).sort()).toEqual([ids.editor, ids.owner].sort());

      const fromCp = (await call("viewer", "GET", `/files/${fileId}/replay?checkpointId=${cp.id}`)).json();
      expect(fromCp.totalEvents).toBe(1);
      expect(fromCp.events).toHaveLength(1);
      expect(fromCp.events[0]).toMatchObject({ userId: ids.owner, origin: "edit" });
      expect(fromCp.base.checkpointId).toBe(cp.id);

      // replaying from the checkpoint reproduces the full result
      const d = new Y.Doc();
      Y.applyUpdate(d, new Uint8Array(Buffer.from(fromCp.base.state, "base64")));
      for (const e of fromCp.events) Y.applyUpdate(d, new Uint8Array(Buffer.from(e.update, "base64")));
      expect(d.getText("content").toString()).toBe("abc");
    });

    it("pages with a cursor and is members-only", async () => {
      const p1 = (await call("viewer", "GET", `/files/${fileId}/replay?limit=2`)).json();
      expect(p1.events).toHaveLength(2);
      expect(p1.nextAfter).toBe(p1.events[1].id);
      const p2 = (await call("viewer", "GET", `/files/${fileId}/replay?limit=2&after=${p1.nextAfter}`)).json();
      expect(p2.events).toHaveLength(1);
      expect(p2.base).toBeNull();
      expect(p2.nextAfter).toBeNull();
      expect((await call("outsider", "GET", `/files/${fileId}/replay`)).statusCode).toBe(404);
      expect((await call(null, "GET", `/files/${fileId}/replay`)).statusCode).toBe(401);
      expect((await call("viewer", "GET", `/files/${fileId}/replay?checkpointId=nope`)).statusCode).toBe(404);
    });
  });
});
