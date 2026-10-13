// Server-side edits (accepting a suggestion, restoring a version) end to end: real Hocuspocus server,
// real Postgres, real WebSocket clients, and the signed /internal endpoints the API calls.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { PrismaClient } from "@collabcode/db";
import { signCollabToken } from "@collabcode/shared/collab-token";
import { createAnchors } from "@collabcode/shared";
import { createCollabServer } from "./server";
import { internalPost, sleep, until } from "./test-utils";

const SECRET = "review-secret-review-secret-review-secret";
const run = describe.skipIf(!process.env.DATABASE_URL);

run("server-side edits (integration)", () => {
  const prisma = new PrismaClient();
  const users: Record<string, string> = {};
  let projectId = "";
  let fileId = "";
  let port = 0;
  let server: ReturnType<typeof createCollabServer>;
  const providers: HocuspocusProvider[] = [];
  const sockets: HocuspocusProviderWebsocket[] = [];

  async function connect(who: string) {
    const doc = new Y.Doc();
    const websocketProvider = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}`, WebSocketPolyfill: WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider, name: `file:${fileId}`, document: doc, token: await signCollabToken(users[who]!, SECRET) });
    provider.attach();
    providers.push(provider);
    sockets.push(websocketProvider);
    await until(() => provider.isSynced);
    return { doc, text: doc.getText("content") };
  }
  const post = (path: string, body: unknown, opts?: { signature?: string; timestamp?: string }) => internalPost(port, SECRET, path, body, opts);
  const settle = () => sleep(700);

  beforeAll(async () => {
    for (const key of ["alice", "bob"]) {
      users[key] = (await prisma.user.create({ data: { name: `Rev ${key}`, email: `${randomUUID()}@test.local` } })).id;
    }
    projectId = (await prisma.project.create({ data: { name: "review", language: "PYTHON", ownerId: users.alice! } })).id;
    await prisma.projectMember.createMany({
      data: [
        { projectId, userId: users.alice!, role: "OWNER", color: "#E69F00", initials: "RA" },
        { projectId, userId: users.bob!, role: "COMMENTER", color: "#56B4E9", initials: "RB" },
      ],
    });
    fileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "main.py", type: "FILE" } })).id;
    port = 23000 + Math.floor(Math.random() * 9000);
    server = createCollabServer({ prisma, secret: SECRET, port, debounce: 100, authorship: { idleMs: 150, maxMs: 500 } });
    await server.listen();
  });

  afterAll(async () => {
    providers.forEach((p) => p.destroy());
    sockets.forEach((s) => s.destroy());
    await server.destroy();
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
  });

  it("refuses unsigned, wrongly signed and stale requests", async () => {
    expect((await post("/internal/flush", { fileIds: [] }, { signature: "00" })).status).toBe(401);
    expect((await post("/internal/flush", { fileIds: [] }, { timestamp: String(Date.now() - 10 * 60_000) })).status).toBe(401);
    const bare = await fetch(`http://127.0.0.1:${port}/internal/flush`, { method: "POST", body: "{}" });
    expect(bare.status).toBe(401);
    expect((await post("/internal/nope", {})).status).toBe(404);
  });

  it("accepting a suggestion applies it live, credited to the SUGGESTER with origin suggestion-accept; anchors survive concurrent edits above", async () => {
    const alice = await connect("alice");
    alice.text.insert(0, "def main():\n    print('hello world')\n");
    await until(() => alice.text.length > 0);
    await settle();

    // Bob (a commenter) anchors "hello world" ...
    const start = alice.text.toString().indexOf("hello world");
    const anchors = createAnchors(Y, alice.text, start, start + "hello world".length);
    // ... then Alice adds lines ABOVE it and edits right before it
    alice.text.insert(0, "# header 1\n# header 2\n");
    alice.text.insert(alice.text.toString().indexOf("hello world"), ">> ");
    await settle();

    const resolved = await post("/internal/resolve", { fileId, anchors });
    expect(resolved.json).toMatchObject({ status: "ok", text: "hello world", gone: false });

    const res = await post("/internal/edit", {
      fileId,
      userId: users.bob,
      origin: "suggestion-accept",
      op: { type: "replace-range", anchors, newText: "hi there" },
    });
    expect(res.json).toMatchObject({ status: "applied", replaced: "hello world" });
    await until(() => alice.text.toString().includes("hi there"));
    expect(alice.text.toString()).toBe("# header 1\n# header 2\ndef main():\n    print('>> hi there')\n");

    await settle();
    const events = await prisma.docEvent.findMany({ where: { fileId, origin: "suggestion-accept" } });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.userId === users.bob)).toBe(true); // credited to the suggester
    expect(events.reduce((n, e) => n + e.added, 0)).toBe("hi there".length);
    expect(events.reduce((n, e) => n + e.removed, 0)).toBe("hello world".length);
    expect(await prisma.docEvent.count({ where: { fileId, userId: users.bob, origin: "edit" } })).toBe(0);
    // the snapshot was written too
    const snap = await prisma.docSnapshot.findUniqueOrThrow({ where: { fileId } });
    const d = new Y.Doc();
    Y.applyUpdate(d, new Uint8Array(snap.state));
    expect(d.getText("content").toString()).toContain("hi there");
  });

  it("a suggestion whose text was deleted is stale and changes nothing", async () => {
    const alice = await connect("alice");
    const before = alice.text.toString();
    const start = before.indexOf("def main");
    const anchors = createAnchors(Y, alice.text, start, start + "def main():".length);
    alice.text.delete(start, "def main():".length);
    await until(() => !alice.text.toString().includes("def main"));
    const res = await post("/internal/edit", { fileId, userId: users.bob, origin: "suggestion-accept", op: { type: "replace-range", anchors, newText: "def other():" } });
    expect(res.json).toEqual({ status: "stale" });
    expect(alice.text.toString()).not.toContain("def other");
  });

  it("set-text (restore) changes only what differs and is credited to the restorer with origin restore", async () => {
    const alice = await connect("alice");
    const current = alice.text.toString();
    const target = current.replace("hi there", "hello world");
    const res = await post("/internal/edit", { fileId, userId: users.alice, origin: "restore", op: { type: "set-text", text: target } });
    expect(res.json.status).toBe("applied");
    expect(res.json.replaced).toBe("i there"); // the shared leading "h" is left alone
    await until(() => alice.text.toString() === target);
    await settle();
    const events = await prisma.docEvent.findMany({ where: { fileId, origin: "restore" } });
    expect(events.every((e) => e.userId === users.alice)).toBe(true);
    expect(events.reduce((n, e) => n + e.added, 0)).toBe("ello world".length);
    // identical text: nothing happens
    expect((await post("/internal/edit", { fileId, userId: users.alice, origin: "restore", op: { type: "set-text", text: target } })).json).toEqual({ status: "unchanged" });
  });

  it("flush writes the snapshot and buffered events to the database immediately", async () => {
    const alice = await connect("alice");
    alice.text.insert(alice.text.length, "# flushed");
    await until(() => server.authorship.pending(fileId) > 0);
    await post("/internal/flush", { fileIds: [fileId] });
    const snap = await prisma.docSnapshot.findUniqueOrThrow({ where: { fileId } });
    const d = new Y.Doc();
    Y.applyUpdate(d, new Uint8Array(snap.state));
    expect(d.getText("content").toString()).toContain("# flushed");
    expect(server.authorship.pending(fileId)).toBe(0);
  });

  it("rejects malformed bodies", async () => {
    expect((await post("/internal/edit", { fileId, userId: users.bob, origin: "edit", op: { type: "set-text", text: "x" } })).status).toBe(400);
    expect((await post("/internal/resolve", { fileId, anchors: { start: "!!", end: "!!", collapsed: false } })).status).toBe(400);
  });
});
