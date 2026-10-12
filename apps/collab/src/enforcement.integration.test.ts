// Server-side enforcement against a MODIFIED client.
//
// The other integration tests use the real Hocuspocus provider, which a malicious user would
// not. Here we talk to the WebSocket with hand-built protocol frames, so nothing in a client
// library stands between the attacker and the server. Every role that must not edit
// (viewer, commenter, and guests holding those roles) is tried with several attack shapes,
// and a positive control proves the frames are well-formed: editors' identical frames work.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { readAuthMessage, writeAuthentication } from "@hocuspocus/common";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { PrismaClient, type Role } from "@collabcode/db";
import { signCollabToken } from "@collabcode/shared/collab-token";
import { createCollabServer } from "./server";

const SECRET = "enforcement-secret-enforcement-secret";
const run = describe.skipIf(!process.env.DATABASE_URL);

// Hocuspocus message types (first varint after the document name)
const MSG_SYNC = 0;
const MSG_AUTH = 2;
const MSG_SYNC_STATUS = 8;
// y-protocols sync sub-types (first varint of a Sync message)
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
};

/** A WebSocket client that speaks the Hocuspocus protocol by hand. */
class RawClient {
  ws: WebSocket;
  scope: string | null = null;
  denied: string | null = null;
  /** Server replies to our update frames: true = applied, false = refused. */
  syncStatuses: boolean[] = [];
  closed = false;

  constructor(
    port: number,
    readonly doc: string,
  ) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on("close", () => (this.closed = true));
    this.ws.on("message", (data: Buffer) => this.onFrame(new Uint8Array(data)));
  }

  private onFrame(frame: Uint8Array) {
    const d = decoding.createDecoder(frame);
    decoding.readVarString(d); // document name
    const type = decoding.readVarUint(d);
    if (type === MSG_AUTH) {
      readAuthMessage(
        d,
        () => {},
        (reason) => (this.denied = reason),
        (scope) => (this.scope = scope),
      );
    } else if (type === MSG_SYNC_STATUS) {
      this.syncStatuses.push(decoding.readVarUint(d) === 1);
    }
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  authFrame(token: string) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, MSG_AUTH);
    writeAuthentication(e, token);
    encoding.writeVarString(e, "4.7.0");
    return encoding.toUint8Array(e);
  }

  /** A Sync message carrying a raw Yjs update (what any client sends when its document changes). */
  updateFrame(update: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, SYNC_UPDATE);
    encoding.writeVarUint8Array(e, update);
    return encoding.toUint8Array(e);
  }

  /** The other way to push state: a SyncStep2 message (the reply to the server's state request). */
  step2Frame(update: Uint8Array) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, this.doc);
    encoding.writeVarUint(e, MSG_SYNC);
    encoding.writeVarUint(e, SYNC_STEP2);
    encoding.writeVarUint8Array(e, update);
    return encoding.toUint8Array(e);
  }

  send(frame: Uint8Array) {
    this.ws.send(frame);
  }

  async authenticate(token: string) {
    this.send(this.authFrame(token));
    await until(() => this.scope !== null || this.denied !== null || this.closed);
  }

  close() {
    this.ws.close();
  }
}

/** A Yjs update that inserts `text` at the start of the shared text, as a hostile client would build it. */
function evilInsert(text: string) {
  const d = new Y.Doc();
  d.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(d);
}

run("server-side edit enforcement against a modified client (integration)", () => {
  const prisma = new PrismaClient();
  const users: Record<string, string> = {};
  let projectId = "";
  let fileId = "";
  let port = 0;
  let server: ReturnType<typeof createCollabServer>;
  const clients: RawClient[] = [];
  const providers: HocuspocusProvider[] = [];
  const sockets: HocuspocusProviderWebsocket[] = [];

  // person -> role, and whether they're a guest
  const PEOPLE: Record<string, { role: Role; guest: boolean }> = {
    owner: { role: "OWNER", guest: false },
    editor: { role: "EDITOR", guest: false },
    guestEditor: { role: "EDITOR", guest: true },
    viewer: { role: "VIEWER", guest: false },
    commenter: { role: "COMMENTER", guest: false },
    guestViewer: { role: "VIEWER", guest: true },
    guestCommenter: { role: "COMMENTER", guest: true },
  };
  const CANNOT_EDIT = ["viewer", "commenter", "guestViewer", "guestCommenter"];
  const CAN_EDIT = ["owner", "editor", "guestEditor"];

  const tokenFor = (who: string) => signCollabToken(users[who]!, SECRET);

  async function raw(doc = `file:${fileId}`) {
    const c = new RawClient(port, doc);
    clients.push(c);
    await c.open();
    return c;
  }

  /** A normal, well-behaved observer used only to read what the server really holds. */
  async function observe(who = "owner", doc = `file:${fileId}`) {
    const websocketProvider = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${port}`, WebSocketPolyfill: WebSocket });
    const provider = new HocuspocusProvider({ websocketProvider, name: doc, document: new Y.Doc(), token: await tokenFor(who) });
    provider.attach();
    providers.push(provider);
    sockets.push(websocketProvider);
    await until(() => provider.isSynced);
    return provider.document.getText("content");
  }

  beforeAll(async () => {
    for (const [key, p] of Object.entries(PEOPLE)) {
      users[key] = (await prisma.user.create({ data: { name: `Enf ${key}`, isGuest: p.guest, email: p.guest ? null : `${randomUUID()}@test.local` } })).id;
    }
    projectId = (await prisma.project.create({ data: { name: "enforcement", language: "PYTHON", ownerId: users.owner! } })).id;
    await prisma.projectMember.createMany({
      data: Object.entries(PEOPLE).map(([key, p], i) => ({
        projectId,
        userId: users[key]!,
        role: p.role,
        color: ["#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7"][i]!,
        initials: `E${i}`,
      })),
    });
    fileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "main.py", type: "FILE" } })).id;

    port = 21000 + Math.floor(Math.random() * 9000);
    server = createCollabServer({ prisma, secret: SECRET, port, debounce: 100, redisUrl: process.env.REDIS_URL });
    await server.listen();

    // seed the document through a legitimate editor so there is real content to protect
    const seed = await observe("owner");
    seed.insert(0, "BASE");
    await sleep(300);
  });

  afterAll(async () => {
    clients.forEach((c) => c.close());
    providers.forEach((p) => p.destroy());
    sockets.forEach((s) => s.destroy());
    await server.destroy();
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.docSnapshot.deleteMany({ where: { fileId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await prisma.$disconnect();
  });

  // ---- positive control: proves the hand-built frames are valid ----

  it.each(CAN_EDIT)("CONTROL: %s's hand-built update frame IS applied (so refusals below are meaningful)", async (who) => {
    const marker = `ok-${who}|`;
    const c = await raw();
    await c.authenticate(await tokenFor(who));
    expect(c.scope).toBe("read-write");
    c.send(c.updateFrame(evilInsert(marker)));
    await until(() => c.syncStatuses.length > 0);
    expect(c.syncStatuses[0]).toBe(true);
    const observed = await observe("owner");
    await until(() => observed.toString().includes(marker));
  });

  // ---- the actual enforcement ----

  describe.each(CANNOT_EDIT)("%s (cannot edit)", (who) => {
    it("is told it is read-only", async () => {
      const c = await raw();
      await c.authenticate(await tokenFor(who));
      expect(c.scope).toBe("readonly");
    });

    it("a hand-built update frame is refused and never reaches the document", async () => {
      const c = await raw();
      await c.authenticate(await tokenFor(who));
      const before = (await observe("owner")).toString();
      c.send(c.updateFrame(evilInsert(`HACK-${who}`)));
      await until(() => c.syncStatuses.length > 0);
      expect(c.syncStatuses[0]).toBe(false); // the server explicitly refused it
      await sleep(300);
      const after = (await observe("owner")).toString();
      expect(after).not.toContain("HACK");
      expect(after).toBe(before);
    });

    it("a SyncStep2 frame (the other way to push state) is refused too", async () => {
      const c = await raw();
      await c.authenticate(await tokenFor(who));
      c.send(c.step2Frame(evilInsert(`STEP2-${who}`)));
      await until(() => c.syncStatuses.length > 0);
      expect(c.syncStatuses[0]).toBe(false);
      await sleep(300);
      expect((await observe("owner")).toString()).not.toContain("STEP2");
    });

    it("pipelining the update right behind the auth frame, without waiting for the reply, changes nothing", async () => {
      const c = await raw();
      const token = await tokenFor(who);
      c.send(c.authFrame(token));
      c.send(c.updateFrame(evilInsert(`RACE-${who}`)));
      await until(() => c.syncStatuses.length > 0 || c.closed);
      await sleep(300);
      expect((await observe("owner")).toString()).not.toContain("RACE");
    });

    it("a flood of updates changes nothing", async () => {
      const c = await raw();
      await c.authenticate(await tokenFor(who));
      for (let i = 0; i < 50; i++) c.send(c.updateFrame(evilInsert(`FLOOD${i}`)));
      await until(() => c.syncStatuses.length >= 50);
      expect(c.syncStatuses.every((s) => s === false)).toBe(true);
      await sleep(300);
      expect((await observe("owner")).toString()).not.toContain("FLOOD");
    });

    it("cannot write to the presence room either", async () => {
      const room = `presence:${projectId}`;
      const c = await raw(room);
      await c.authenticate(await tokenFor(who));
      c.send(c.updateFrame(evilInsert("PRESENCE-HACK")));
      await until(() => c.syncStatuses.length > 0);
      expect(c.syncStatuses[0]).toBe(false);
    });
  });

  it("even an editor cannot write to a presence room (it carries no content)", async () => {
    const c = await raw(`presence:${projectId}`);
    await c.authenticate(await tokenFor("editor"));
    expect(c.scope).toBe("readonly");
    c.send(c.updateFrame(evilInsert("PRESENCE-HACK")));
    await until(() => c.syncStatuses.length > 0);
    expect(c.syncStatuses[0]).toBe(false);
  });

  // ---- nothing was persisted from any attack ----

  it("none of the refused edits reached the database snapshot", async () => {
    await sleep(600); // let the debounced store run
    const row = await prisma.docSnapshot.findUniqueOrThrow({ where: { fileId } });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.state));
    const text = doc.getText("content").toString();
    expect(text).toContain("BASE");
    for (const marker of ["HACK", "STEP2", "RACE", "FLOOD", "PRESENCE"]) expect(text).not.toContain(marker);
    for (const who of CAN_EDIT) expect(text).toContain(`ok-${who}|`); // the legitimate edits did persist
  });

  // ---- access to documents at all ----

  it("people outside the project are refused outright, as is a forged token", async () => {
    const stranger = await prisma.user.create({ data: { name: "Enf stranger", email: `${randomUUID()}@test.local` } });
    try {
      const c = await raw();
      await c.authenticate(await signCollabToken(stranger.id, SECRET));
      expect(c.scope).toBeNull();
      expect(c.denied ?? (c.closed ? "closed" : null)).not.toBeNull();
      c.send(c.updateFrame(evilInsert("STRANGER")));
      await sleep(300);
      expect((await observe("owner")).toString()).not.toContain("STRANGER");

      const forged = await raw();
      await forged.authenticate(await signCollabToken(users.owner!, "z".repeat(40)));
      expect(forged.scope).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: stranger.id } });
    }
  });

  it("a guest from another project cannot open this project's files", async () => {
    const otherOwner = await prisma.user.create({ data: { name: "Enf other owner", email: `${randomUUID()}@test.local` } });
    const otherGuest = await prisma.user.create({ data: { name: "Enf other guest", isGuest: true } });
    const otherProject = await prisma.project.create({ data: { name: "other", language: "PYTHON", ownerId: otherOwner.id } });
    await prisma.projectMember.create({ data: { projectId: otherProject.id, userId: otherGuest.id, role: "EDITOR", color: "#999999", initials: "OG" } });
    try {
      const c = await raw();
      await c.authenticate(await signCollabToken(otherGuest.id, SECRET));
      expect(c.scope).toBeNull();
    } finally {
      await prisma.project.delete({ where: { id: otherProject.id } });
      await prisma.user.deleteMany({ where: { id: { in: [otherOwner.id, otherGuest.id] } } });
    }
  });
});
