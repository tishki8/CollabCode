// End-to-end test of the collab server with real WebSocket clients and a real database.
// Needs DATABASE_URL (migrated). Redis is optional: set REDIS_URL to also test cross-instance sync.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { PrismaClient } from "@collabcode/db";
import { signCollabToken } from "@collabcode/shared/collab-token";
import { createCollabServer } from "./server";

const SECRET = "integration-secret-integration-secret";
const run = describe.skipIf(!process.env.DATABASE_URL);

const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run("collab server (integration)", () => {
  const prisma = new PrismaClient();
  const users: Record<string, string> = {};
  let projectId = "";
  let fileId = "";
  let port = 0;
  let server: ReturnType<typeof createCollabServer>;
  const providers: HocuspocusProvider[] = [];
  const sockets: HocuspocusProviderWebsocket[] = [];

  async function connect(who: string, name = `file:${fileId}`, token?: string, onPort = port) {
    const doc = new Y.Doc();
    const websocketProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${onPort}`,
      WebSocketPolyfill: WebSocket,
    });
    const provider = new HocuspocusProvider({
      websocketProvider,
      name,
      document: doc,
      token: token ?? (await signCollabToken(users[who]!, SECRET)),
    });
    provider.attach(); // required when the websocket is created separately
    providers.push(provider);
    sockets.push(websocketProvider);
    return { doc, provider, text: doc.getText("content") };
  }

  beforeAll(async () => {
    const mk = async (key: string) => {
      const u = await prisma.user.create({ data: { name: `Test ${key}`, email: `${randomUUID()}@test.local` } });
      users[key] = u.id;
    };
    await Promise.all(["owner", "editor", "viewer", "outsider"].map(mk));
    const project = await prisma.project.create({ data: { name: "collab-it", language: "PYTHON", ownerId: users.owner! } });
    projectId = project.id;
    await prisma.projectMember.createMany({
      data: [
        { projectId, userId: users.owner!, role: "OWNER", color: "#E69F00", initials: "TO" },
        { projectId, userId: users.editor!, role: "EDITOR", color: "#56B4E9", initials: "TE" },
        { projectId, userId: users.viewer!, role: "VIEWER", color: "#009E73", initials: "TV" },
      ],
    });
    fileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "main.py", type: "FILE" } })).id;

    port = 20000 + Math.floor(Math.random() * 10000);
    server = createCollabServer({ prisma, secret: SECRET, port, debounce: 100, redisUrl: process.env.REDIS_URL });
    await server.listen();
  });

  afterAll(async () => {
    providers.forEach((p) => p.destroy());
    sockets.forEach((s) => s.destroy());
    await server.destroy();
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.docSnapshot.deleteMany({ where: { fileId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
  });

  it("syncs edits between two editors", async () => {
    const a = await connect("owner");
    const b = await connect("editor");
    await until(() => a.provider.isSynced && b.provider.isSynced);
    a.text.insert(0, "hello");
    await until(() => b.text.toString() === "hello");
    b.text.insert(5, " world");
    await until(() => a.text.toString() === "hello world");
  });

  it("merges concurrent edits made while one client is offline", async () => {
    const a = await connect("owner");
    const b = await connect("editor");
    await until(() => a.provider.isSynced && b.provider.isSynced);
    const base = a.text.toString();
    b.provider.configuration.websocketProvider.disconnect();
    await sleep(100);
    a.text.insert(0, "A:");
    b.text.insert(b.text.length, ":B"); // edit while offline
    await sleep(100);
    expect(a.text.toString()).not.toContain(":B");
    b.provider.configuration.websocketProvider.connect();
    await until(() => a.text.toString().includes(":B") && b.text.toString().includes("A:"));
    expect(a.text.toString()).toBe(b.text.toString());
    expect(a.text.toString()).toBe(`A:${base}:B`);
  });

  it("lets a viewer read but silently drops the viewer's edits", async () => {
    const owner = await connect("owner");
    const viewer = await connect("viewer");
    await until(() => owner.provider.isSynced && viewer.provider.isSynced);
    expect(viewer.text.toString()).toBe(owner.text.toString()); // can read
    const before = owner.text.toString();
    viewer.text.insert(0, "HACKED");
    await sleep(500);
    expect(owner.text.toString()).toBe(before); // server did not apply or broadcast it
    // and nothing leaked into a fresh connection either
    const fresh = await connect("editor");
    await until(() => fresh.provider.isSynced);
    expect(fresh.text.toString()).toBe(before);
  });

  it("rejects non-members, forged tokens and bad document names", async () => {
    for (const [who, name, token] of [
      ["outsider", undefined, undefined],
      ["owner", undefined, "forged.token.value"],
      ["owner", "file:does-not-exist", undefined],
      ["owner", "file:../../etc/passwd", undefined],
    ] as const) {
      const c = await connect(who, name, token);
      let failed = false;
      c.provider.on("authenticationFailed", () => (failed = true));
      await sleep(600);
      expect(failed || !c.provider.isSynced, `${who} ${name}`).toBe(true);
      expect(c.text.toString()).toBe("");
    }
  });

  it("overwrites a spoofed identity in awareness", async () => {
    const a = await connect("editor");
    const b = await connect("owner");
    await until(() => a.provider.isSynced && b.provider.isSynced);
    a.provider.awareness!.setLocalState({ user: { name: "Totally The Owner", color: "red", initials: "TO" }, junk: 1 });
    await until(() => [...b.provider.awareness!.getStates().values()].some((s) => s.user?.name === "Test editor"));
    const states = [...b.provider.awareness!.getStates().values()];
    expect(states.some((s) => s.user?.name === "Totally The Owner")).toBe(false);
    expect(states.some((s) => "junk" in s)).toBe(false);
  });

  it("presence rooms show who is online and are read-only", async () => {
    const a = await connect("owner", `presence:${projectId}`);
    const v = await connect("viewer", `presence:${projectId}`);
    await until(() => a.provider.isSynced && v.provider.isSynced);
    v.provider.awareness!.setLocalStateField("fileId", fileId);
    await until(() => [...a.provider.awareness!.getStates().values()].some((s) => s.fileId === fileId && s.user?.name === "Test viewer"));
    a.doc.getText("content").insert(0, "x");
    await sleep(300);
    expect(v.doc.getText("content").toString()).toBe("");
  });

  it("closes connections that send oversized frames", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(Buffer.alloc(6 * 1024 * 1024)); // limit is 5 MB
    expect(await closed).toBe(1009); // "message too big"
  });

  it("persists documents so they survive a server restart", async () => {
    const a = await connect("owner");
    await until(() => a.provider.isSynced);
    a.text.insert(a.text.length, "\n# persisted");
    const expected = a.text.toString();
    await sleep(600); // > debounce
    a.provider.destroy();
    await server.destroy();

    // brand-new server instance + brand-new client: content must come from the database
    server = createCollabServer({ prisma, secret: SECRET, port, debounce: 100, redisUrl: process.env.REDIS_URL });
    await server.listen();
    const c = await connect("editor");
    await until(() => c.provider.isSynced);
    expect(c.text.toString()).toBe(expected);
    expect(await prisma.docSnapshot.count({ where: { fileId } })).toBe(1);
  });

  // Horizontal scaling: two collab instances sharing one Redis must act as one.
  it.skipIf(!process.env.REDIS_URL)("syncs clients connected to different server instances via Redis", async () => {
    const port2 = port + 1;
    const second = createCollabServer({ prisma, secret: SECRET, port: port2, debounce: 100, redisUrl: process.env.REDIS_URL });
    await second.listen();
    try {
      const a = await connect("owner", undefined, undefined, port);
      const b = await connect("editor", undefined, undefined, port2);
      await until(() => a.provider.isSynced && b.provider.isSynced);
      a.text.insert(0, "via-redis ");
      await until(() => b.text.toString().startsWith("via-redis "), 8000);
      b.provider.awareness!.setLocalStateField("fileId", fileId);
      await until(() => [...a.provider.awareness!.getStates().values()].some((s) => s.user?.name === "Test editor"), 8000);
    } finally {
      await second.destroy();
    }
  });
});
