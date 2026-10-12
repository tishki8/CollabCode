// Authorship end to end: real Hocuspocus server, real Postgres, real WebSocket clients.
// Attribution is read back the way the product does: event rows -> AttributionIndex -> blame of the live text.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { PrismaClient } from "@collabcode/db";
import { signCollabToken } from "@collabcode/shared/collab-token";
import { AttributionIndex, blameYText, type LineBlame } from "@collabcode/shared";
import { createCollabServer } from "./server";
import { RawClient, evilInsert, sleep, until } from "./test-utils";

const SECRET = "authorship-secret-authorship-secret";
const run = describe.skipIf(!process.env.DATABASE_URL);

run("authorship (integration)", () => {
  const prisma = new PrismaClient();
  const users: Record<string, string> = {};
  const names: Record<string, string> = {};
  let projectId = "";
  let fileId = "";
  let port = 0;
  let server: ReturnType<typeof createCollabServer>;
  const providers: HocuspocusProvider[] = [];
  const sockets: HocuspocusProviderWebsocket[] = [];
  const raws: RawClient[] = [];

  const start = () => {
    server = createCollabServer({
      prisma,
      secret: SECRET,
      port,
      debounce: 100,
      redisUrl: process.env.REDIS_URL,
      authorship: { idleMs: 150, maxMs: 500 },
    });
    return server.listen();
  };

  async function connect(who: string, name = `file:${fileId}`) {
    const doc = new Y.Doc();
    const websocketProvider = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}`, WebSocketPolyfill: WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider, name, document: doc, token: await signCollabToken(users[who]!, SECRET) });
    provider.attach();
    providers.push(provider);
    sockets.push(websocketProvider);
    await until(() => provider.isSynced);
    return { doc, provider, websocketProvider, text: doc.getText("content") };
  }

  /** Type one character at a time, as a person would. */
  const typeKeys = async (t: Y.Text, offset: number, s: string) => {
    for (const [i, ch] of [...s].entries()) t.insert(offset + i, ch);
  };

  /** Everything the product knows about authorship of this file, from the database. */
  async function attributionIndex() {
    const rows = await prisma.docEvent.findMany({ where: { fileId, clockEnd: { gt: 0 } }, select: { clientId: true, clockStart: true, clockEnd: true, userId: true, createdAt: true } });
    return new AttributionIndex(
      rows.filter((r) => r.clockEnd > r.clockStart).map((r) => ({ client: Number(r.clientId), start: r.clockStart, end: r.clockEnd, user: r.userId, at: r.createdAt.getTime() })),
    );
  }
  const blame = async (text: Y.Text): Promise<LineBlame[]> => blameYText(text, await attributionIndex()).lines;
  const who = (id: string | null | undefined) => (id ? names[id] ?? id : "unknown");
  const authorsOf = (line: LineBlame) => line.authors.map((a) => who(a.user));
  const eventCount = (userKey?: string) => prisma.docEvent.count({ where: { fileId, ...(userKey ? { userId: users[userKey]! } : {}) } });
  const settle = () => sleep(700); // > batch idle window + a margin

  /** A brand-new file in the project so each test starts from an empty document. */
  async function freshFile() {
    fileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: `f-${randomUUID().slice(0, 8)}.py`, type: "FILE" } })).id;
  }

  beforeAll(async () => {
    for (const [key, guest] of [["alice", false], ["bob", false], ["gina", true], ["viewer", false]] as const) {
      const u = await prisma.user.create({ data: { name: `Auth ${key}`, isGuest: guest, email: guest ? null : `${randomUUID()}@test.local` } });
      users[key] = u.id;
      names[u.id] = `Auth ${key}`;
    }
    projectId = (await prisma.project.create({ data: { name: "authorship", language: "PYTHON", ownerId: users.alice! } })).id;
    await prisma.projectMember.createMany({
      data: [
        { projectId, userId: users.alice!, role: "OWNER", color: "#E69F00", initials: "AA" },
        { projectId, userId: users.bob!, role: "EDITOR", color: "#56B4E9", initials: "AB" },
        { projectId, userId: users.gina!, role: "EDITOR", color: "#009E73", initials: "AG" },
        { projectId, userId: users.viewer!, role: "VIEWER", color: "#F0E442", initials: "AV" },
      ],
    });
    port = 22000 + Math.floor(Math.random() * 9000);
    await start();
  });

  beforeEach(freshFile);

  afterAll(async () => {
    raws.forEach((r) => r.close());
    providers.forEach((p) => p.destroy());
    sockets.forEach((s) => s.destroy());
    await server.destroy();
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
  });

  it("Alice and Bob each type on their own line: each line is attributed to the right person", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    await typeKeys(a.text, 0, "alice line\n");
    await until(() => b.text.toString() === "alice line\n");
    await typeKeys(b.text, b.text.length, "bob line");
    await until(() => a.text.toString() === "alice line\nbob line");
    await settle();

    const lines = await blame(a.text);
    expect(who(lines[0]!.main?.user)).toBe("Auth alice");
    expect(who(lines[1]!.main?.user)).toBe("Auth bob");
    expect(lines[0]!.others).toBe(0);
  });

  it("batches keystrokes: typing 60 characters writes one or two events, not 60", async () => {
    const a = await connect("alice");
    await typeKeys(a.text, 0, "x".repeat(60));
    await settle();
    const events = await prisma.docEvent.findMany({ where: { fileId, userId: users.alice! } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(2);
    expect(events.reduce((t, e) => t + e.added, 0)).toBe(60);
    // each event's merged update replays to a prefix of what was typed
    const replay = new Y.Doc();
    events.forEach((e) => Y.applyUpdate(replay, new Uint8Array(e.update)));
    expect(replay.getText("content").toString()).toBe("x".repeat(60));
  });

  it("two users typing on the same line at the same time are both credited", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    a.text.insert(0, "total = ");
    await until(() => b.text.toString() === "total = ");
    // concurrent: neither has seen the other's edit yet
    b.websocketProvider.disconnect();
    await sleep(100);
    await typeKeys(a.text, 8, "compute(items)");
    await typeKeys(b.text, 8, "0");
    b.websocketProvider.connect();
    await until(() => a.text.toString() === b.text.toString() && a.text.length === 8 + 14 + 1);
    await settle();

    const [line] = await blame(a.text);
    expect(authorsOf(line!).sort()).toEqual(["Auth alice", "Auth bob"]);
    expect(who(line!.main!.user)).toBe("Auth alice");
    expect(line!.others).toBe(1);
  });

  it("text deleted and retyped by someone else credits the new author", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    a.text.insert(0, "return 42");
    await until(() => b.text.toString() === "return 42");
    await settle();
    expect(who((await blame(a.text))[0]!.main!.user)).toBe("Auth alice");

    b.text.delete(0, b.text.length);
    b.text.insert(0, "return 42"); // identical text, retyped
    await until(() => a.text.toString() === "return 42");
    await settle();
    const [line] = await blame(a.text);
    expect(who(line!.main!.user)).toBe("Auth bob");
    expect(line!.others).toBe(0);
    const bobEvents = await prisma.docEvent.findMany({ where: { fileId, userId: users.bob! } });
    expect(bobEvents.reduce((t, e) => t + e.removed, 0)).toBe(9);
  });

  it("a 100 KB paste is one range and one event", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    a.text.insert(0, "row = 1\n".repeat(12_500));
    await until(() => b.text.length === 100_000, 8000);
    await settle();
    const events = await prisma.docEvent.findMany({ where: { fileId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ added: 100_000, linesAdded: 12_500, clockStart: 0, clockEnd: 100_000 });
    const lines = await blame(b.text);
    expect(lines).toHaveLength(12_501);
    expect(who(lines[6_000]!.main!.user)).toBe("Auth alice");
  });

  it("undo and redo: the person who performs them gets the credit, undone text has no author", async () => {
    const a = await connect("alice");
    const undo = new Y.UndoManager(a.text, { captureTimeout: 0 });
    a.text.insert(0, "draft");
    await settle();
    undo.undo();
    await until(() => a.text.toString() === "");
    await settle();
    expect((await blame(a.text))[0]!.main).toBeNull();
    undo.redo();
    await until(() => a.text.toString() === "draft");
    await settle();
    expect(who((await blame(a.text))[0]!.main!.user)).toBe("Auth alice");
  });

  it("offline edits merge on reconnect and keep the right author", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    a.text.insert(0, "online\n");
    await until(() => b.text.toString() === "online\n");

    b.websocketProvider.disconnect();
    await sleep(150);
    b.text.insert(b.text.length, "typed offline by bob\n"); // queued locally
    a.text.insert(a.text.length, "alice meanwhile\n");
    await sleep(300);
    expect(a.text.toString()).not.toContain("offline");

    b.websocketProvider.connect();
    await until(() => a.text.toString().includes("offline") && b.text.toString().includes("meanwhile"), 8000);
    await settle();
    const lines = await blame(a.text);
    const texts = a.text.toString().split("\n");
    const author = (needle: string) => who(lines[texts.findIndex((t) => t.includes(needle))]!.main!.user);
    expect(author("online")).toBe("Auth alice");
    expect(author("offline")).toBe("Auth bob");
    expect(author("meanwhile")).toBe("Auth alice");
  });

  it("a guest is attributed by their guest identity", async () => {
    const g = await connect("gina");
    await typeKeys(g.text, 0, "from a guest");
    await settle();
    const [line] = await blame(g.text);
    expect(line!.main!.user).toBe(users.gina);
    expect(who(line!.main!.user)).toBe("Auth gina");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users.gina! } })).isGuest).toBe(true);
  });

  it("refused edits from a viewer leave no trace in the event log", async () => {
    const a = await connect("alice");
    a.text.insert(0, "owned");
    await settle();
    const before = await eventCount();
    const viewer = new RawClient(port, `file:${fileId}`);
    raws.push(viewer);
    await viewer.open();
    await viewer.authenticate(await signCollabToken(users.viewer!, SECRET));
    viewer.send(viewer.updateFrame(evilInsert("VIEWER-EDIT")));
    await until(() => viewer.syncStatuses.length > 0);
    await settle();
    expect(viewer.syncStatuses[0]).toBe(false);
    expect(await eventCount()).toBe(before);
    expect(await eventCount("viewer")).toBe(0);
  });

  describe("clientID ownership over the wire", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("rejects Bob pre-sending text under Alice's clientID: connection closed, nothing applied or credited, Alice unaffected", async () => {
      const a = await connect("alice");
      await typeKeys(a.text, 0, "alice text");
      await settle();
      const aliceClient = a.doc.clientID;
      expect(await prisma.yClient.findUnique({ where: { fileId_clientId: { fileId, clientId: BigInt(aliceClient) } } })).toMatchObject({ userId: users.alice });

      // Bob (a legitimate editor) hand-builds items under ALICE's clientID, at the clocks she uses next
      const bob = new RawClient(port, `file:${fileId}`);
      raws.push(bob);
      await bob.open();
      await bob.authenticate(await signCollabToken(users.bob!, SECRET));
      expect(bob.scope).toBe("read-write");
      const forged = new Y.Doc();
      forged.clientID = aliceClient;
      forged.getText("content").insert(0, "F".repeat(20)); // clocks 0..19: 10..19 are new to the server
      const eventsBefore = await eventCount();
      bob.send(bob.updateFrame(Y.encodeStateAsUpdate(forged)));
      await until(() => bob.closeReason !== null);
      expect(bob.closeReason).toBe("Forbidden");

      await settle();
      expect(a.text.toString()).toBe("alice text"); // never applied, never broadcast
      expect(await eventCount()).toBe(eventsBefore); // nothing recorded for Bob
      expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes("rejected update"))).toBe(true); // logged

      // ...and Alice can keep typing under her own id
      await typeKeys(a.text, a.text.length, "!!");
      await settle();
      expect(who((await blame(a.text))[0]!.main!.user)).toBe("Auth alice");
      expect((await attributionIndex()).lookup(aliceClient, 11)!.user).toBe(users.alice);
    });

    it("rejects an awareness (cursor) update that claims another user's clientID", async () => {
      const a = await connect("alice");
      a.text.insert(0, "x");
      await settle();
      const bob = new RawClient(port, `file:${fileId}`);
      raws.push(bob);
      await bob.open();
      await bob.authenticate(await signCollabToken(users.bob!, SECRET));
      bob.send(bob.awarenessFrame(a.doc.clientID));
      await until(() => bob.closeReason !== null);
      expect(bob.closeReason).toBe("Forbidden");
    });

    it("the claim persists across a server restart", async () => {
      const a = await connect("alice");
      await typeKeys(a.text, 0, "before restart");
      await settle();
      const aliceClient = a.doc.clientID;
      providers.forEach((p) => p.destroy());
      sockets.forEach((s) => s.destroy());
      await server.destroy();
      await start();

      const bob = new RawClient(port, `file:${fileId}`);
      raws.push(bob);
      await bob.open();
      await bob.authenticate(await signCollabToken(users.bob!, SECRET));
      const forged = new Y.Doc();
      forged.clientID = aliceClient;
      forged.getText("content").insert(0, "G".repeat(40));
      bob.send(bob.updateFrame(Y.encodeStateAsUpdate(forged)));
      await until(() => bob.closeReason !== null);
      expect(bob.closeReason).toBe("Forbidden");
    });
  });

  it("authorship survives a server restart: the document and who wrote each line load back correctly", async () => {
    const a = await connect("alice");
    const b = await connect("bob");
    await typeKeys(a.text, 0, "alice first\n");
    await until(() => b.text.toString() === "alice first\n");
    await typeKeys(b.text, b.text.length, "bob second\n");
    await until(() => a.text.toString() === "alice first\nbob second\n");
    await typeKeys(a.text, a.text.length, "alice third");
    await until(() => b.text.toString().endsWith("alice third"));
    const expectedText = a.text.toString();
    await sleep(300); // do NOT wait for the idle window: shutdown itself must flush

    providers.forEach((p) => p.destroy());
    sockets.forEach((s) => s.destroy());
    await server.destroy(); // graceful shutdown flushes buffered events
    await start();

    const c = await connect("viewer"); // a brand-new connection reading the reloaded document
    expect(c.text.toString()).toBe(expectedText);
    const lines = await blame(c.text);
    expect(lines.map((l) => who(l.main?.user))).toEqual(["Auth alice", "Auth bob", "Auth alice"]);
  });

  it("text that predates authorship tracking is reported as unknown, never blamed on someone", async () => {
    const legacy = new Y.Doc();
    legacy.clientID = 99_999;
    legacy.getText("content").insert(0, "legacy line\n");
    await prisma.docSnapshot.create({ data: { fileId, state: Buffer.from(Y.encodeStateAsUpdate(legacy)) } });
    const a = await connect("alice");
    expect(a.text.toString()).toBe("legacy line\n");
    a.text.insert(a.text.length, "new line");
    await settle();
    const lines = await blame(a.text);
    expect(lines[0]!.main!.user).toBeNull();
    expect(who(lines[1]!.main!.user)).toBe("Auth alice");
  });

  it("snapshots never get ahead of the event log", async () => {
    const a = await connect("alice");
    await typeKeys(a.text, 0, "snapshot me");
    await sleep(800); // wait for the snapshot, then check the events it depends on are already stored
    const snapshot = await prisma.docSnapshot.findUniqueOrThrow({ where: { fileId } });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(snapshot.state));
    expect(doc.getText("content").toString()).toBe("snapshot me");
    const lines = blameYText(doc.getText("content"), await attributionIndex()).lines;
    expect(who(lines[0]!.main!.user)).toBe("Auth alice"); // attribution for everything in the snapshot exists
  });
});
