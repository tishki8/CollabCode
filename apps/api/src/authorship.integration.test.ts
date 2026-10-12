// The authorship read APIs against a real Postgres, with an event log shaped exactly as the collab
// server writes it (real Yjs updates, not hand-made bytes).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { PrismaClient } from "@collabcode/db";
import { MAX_REPLAY_EVENTS } from "@collabcode/shared";
import { hashToken } from "./services/tokens";
import { buildApp } from "./app";

const WEB = "http://localhost:3000";
const run = describe.skipIf(!process.env.DATABASE_URL);
const T0 = Date.parse("2026-03-01T10:00:00Z");
const MIN = 60_000;

run("authorship APIs (integration)", () => {
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const cleanup: string[] = [];
  let projectId = "";
  let fileId = "";
  let otherFileId = "";

  async function makeUser(key: string, isGuest = false) {
    const token = randomUUID();
    const u = await prisma.user.create({
      data: {
        name: `Au ${key}`,
        isGuest,
        email: isGuest ? null : `${randomUUID()}@test.local`,
        sessions: isGuest ? undefined : { create: { sessionToken: token, expires: new Date(Date.now() + 3_600_000) } },
        guestSessions: isGuest ? { create: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 3_600_000) } } : undefined,
      },
    });
    cleanup.push(u.id);
    // guests authenticate with their own cookie, accounts with the Auth.js session cookie
    cookies[key] = isGuest ? `cc_guest=${token}` : `authjs.session-token=${token}`;
    ids[key] = u.id;
  }
  const get = (who: string | null, url: string) =>
    app.inject({ method: "GET", url, remoteAddress: `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`, headers: { ...(who ? { cookie: cookies[who]! } : {}), origin: WEB } });

  /** An event row as the collab server writes it. */
  const row = (fid: string, userKey: string, clientId: number, start: number, end: number, update: Uint8Array, atMin: number, o: { added?: number; removed?: number; linesAdded?: number; linesRemoved?: number } = {}) => ({
    fileId: fid,
    userId: ids[userKey]!,
    clientId: BigInt(clientId),
    clockStart: start,
    clockEnd: end,
    update: Buffer.from(update),
    added: o.added ?? end - start,
    removed: o.removed ?? 0,
    linesAdded: o.linesAdded ?? 0,
    linesRemoved: o.linesRemoved ?? 0,
    startedAt: new Date(T0 + atMin * MIN),
    createdAt: new Date(T0 + atMin * MIN + 20_000),
  });

  beforeAll(async () => {
    for (const k of ["owner", "bob", "viewer", "outsider"]) await makeUser(k);
    await makeUser("guest", true);
    projectId = (await prisma.project.create({ data: { name: "authorship api", language: "PYTHON", ownerId: ids.owner! } })).id;
    await prisma.projectMember.createMany({
      data: [
        { projectId, userId: ids.owner!, role: "OWNER", color: "#E69F00", initials: "AO" },
        { projectId, userId: ids.bob!, role: "EDITOR", color: "#56B4E9", initials: "AB" },
        { projectId, userId: ids.viewer!, role: "VIEWER", color: "#009E73", initials: "AV" },
        { projectId, userId: ids.guest!, role: "VIEWER", color: "#F0E442", initials: "AG" },
      ],
    });
    fileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "main.py", type: "FILE" } })).id;
    otherFileId = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "gone.py", type: "FILE" } })).id;

    // The story: owner types two lines, bob adds a line, owner deletes the first line.
    const a = new Y.Doc({ gc: false });
    a.clientID = 1001;
    const b = new Y.Doc({ gc: false });
    b.clientID = 2002;
    let u: Uint8Array = new Uint8Array();
    a.on("update", (x: Uint8Array) => (u = x));
    b.on("update", (x: Uint8Array) => (u = x));
    a.getText("content").insert(0, "one\ntwo\n");
    const u1 = u;
    Y.applyUpdate(b, u1);
    b.getText("content").insert(4, "BOB\n");
    const u2 = u;
    Y.applyUpdate(a, u2);
    a.getText("content").delete(0, 4);
    const u3 = u;

    await prisma.docEvent.createMany({
      data: [
        row(fileId, "owner", 1001, 0, 8, u1, 0, { linesAdded: 2 }),
        row(fileId, "bob", 2002, 0, 4, u2, 10, { linesAdded: 1 }),
        row(fileId, "owner", 1001, 0, 0, u3, 20, { added: 0, removed: 4, linesRemoved: 1 }), // delete-only
      ],
    });
    await prisma.docSnapshot.create({ data: { fileId, state: Buffer.from(Y.encodeStateAsUpdate(a)) } });

    // a second file that is later deleted: its history still counts as work done
    const g = new Y.Doc();
    g.clientID = 3003;
    g.getText("content").insert(0, "scratch\n");
    await prisma.docEvent.create({ data: row(otherFileId, "bob", 3003, 0, 8, Y.encodeStateAsUpdate(g), 30, { linesAdded: 1 }) });
    await prisma.fileNode.update({ where: { id: otherFileId }, data: { deletedAt: new Date() } });

    app = await buildApp({ prisma, webOrigin: WEB, collabSecret: "s".repeat(32), collabPublicUrl: "ws://x" });
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.docEvent.deleteMany({ where: { fileId: { in: [fileId, otherFileId] } } });
    await prisma.docSnapshot.deleteMany({ where: { fileId: { in: [fileId, otherFileId] } } });
    await prisma.user.deleteMany({ where: { id: { in: cleanup } } });
    await prisma.$disconnect();
    await app.close();
  });

  describe("GET /files/:id/attribution", () => {
    it("returns who delivered which item ranges, compactly, and never the update bytes", async () => {
      const res = await get("owner", `/files/${fileId}/attribution`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.users.map((u: { name: string }) => u.name).sort()).toEqual(["Au bob", "Au owner"]);
      expect(body.users.find((u: { id: string }) => u.id === ids.bob)).toMatchObject({ color: "#56B4E9", initials: "AB", isGuest: false });
      // delete-only events carry no range: two ranges for three events
      expect(body.ranges).toHaveLength(2);
      const [client, start, end, userIdx, at] = body.ranges[0];
      expect([client, start, end]).toEqual([1001, 0, 8]);
      expect(body.users[userIdx].id).toBe(ids.owner);
      expect(at).toBe(T0 + 20_000);
      expect(body.hasMore).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/update/i);
    });

    it("is incremental: `after` returns only newer events, and paging works", async () => {
      const first = (await get("owner", `/files/${fileId}/attribution?limit=1`)).json();
      expect(first.hasMore).toBe(true);
      expect(first.ranges).toHaveLength(1);
      const next = (await get("owner", `/files/${fileId}/attribution?after=${first.lastEventId}`)).json();
      expect(next.ranges.map((r: number[]) => r[0])).toEqual([2002]); // bob's range; the delete-only event has none
      expect(BigInt(next.lastEventId)).toBeGreaterThan(BigInt(first.lastEventId));
      const empty = (await get("owner", `/files/${fileId}/attribution?after=${next.lastEventId}`)).json();
      expect(empty).toMatchObject({ ranges: [], hasMore: false, lastEventId: null });
    });

    it("is open to every member (even viewers and guests) but not to outsiders or anonymous callers", async () => {
      for (const who of ["owner", "bob", "viewer", "guest"]) expect((await get(who, `/files/${fileId}/attribution`)).statusCode, who).toBe(200);
      expect((await get("outsider", `/files/${fileId}/attribution`)).statusCode).toBe(404);
      expect((await get(null, `/files/${fileId}/attribution`)).statusCode).toBe(401);
    });

    it("404s for deleted files and rejects malformed cursors", async () => {
      expect((await get("owner", `/files/${otherFileId}/attribution`)).statusCode).toBe(404);
      expect((await get("owner", `/files/${fileId}/attribution?after=abc`)).statusCode).toBe(400);
      expect((await get("owner", `/files/${fileId}/attribution?limit=999999`)).statusCode).toBe(400);
    });
  });

  describe("GET /files/:id/events", () => {
    it("lists changes newest first with counts", async () => {
      const body = (await get("owner", `/files/${fileId}/events`)).json();
      expect(body.events.map((e: { userId: string }) => e.userId)).toEqual([ids.owner, ids.bob, ids.owner]);
      expect(body.events[0]).toMatchObject({ added: 0, removed: 4, linesRemoved: 1 });
      expect(body.events[2]).toMatchObject({ added: 8, linesAdded: 2 });
      expect(body.nextBefore).toBeNull();
    });

    it("filters by person and by time range", async () => {
      const bobOnly = (await get("owner", `/files/${fileId}/events?userId=${ids.bob}`)).json();
      expect(bobOnly.events).toHaveLength(1);
      const from = new Date(T0 + 5 * MIN).toISOString();
      const to = new Date(T0 + 15 * MIN).toISOString();
      const range = (await get("owner", `/files/${fileId}/events?from=${from}&to=${to}`)).json();
      expect(range.events.map((e: { userId: string }) => e.userId)).toEqual([ids.bob]);
      const noOne = (await get("owner", `/files/${fileId}/events?userId=${ids.viewer}`)).json();
      expect(noOne.events).toEqual([]);
    });

    it("pages with a cursor", async () => {
      const p1 = (await get("owner", `/files/${fileId}/events?limit=2`)).json();
      expect(p1.events).toHaveLength(2);
      expect(p1.nextBefore).not.toBeNull();
      const p2 = (await get("owner", `/files/${fileId}/events?limit=2&before=${p1.nextBefore}`)).json();
      expect(p2.events).toHaveLength(1);
      expect(p2.nextBefore).toBeNull();
    });

    it("rejects bad input and outsiders", async () => {
      expect((await get("owner", `/files/${fileId}/events?from=not-a-date`)).statusCode).toBe(400);
      expect((await get("owner", `/files/${fileId}/events?limit=0`)).statusCode).toBe(400);
      expect((await get("outsider", `/files/${fileId}/events`)).statusCode).toBe(404);
    });
  });

  describe("GET /files/:id/history-diff", () => {
    it("shows exactly what one person added and removed, with line numbers", async () => {
      const owner = (await get("owner", `/files/${fileId}/history-diff?userId=${ids.owner}`)).json();
      expect(owner.replayedEvents).toBe(3);
      expect(owner.changes).toHaveLength(2);
      expect(owner.changes[0].hunks).toEqual([{ kind: "add", line: 1, text: "one\ntwo\n" }]);
      expect(owner.changes[1].hunks).toEqual([{ kind: "del", line: 1, text: "one\n" }]);
      const bob = (await get("owner", `/files/${fileId}/history-diff?userId=${ids.bob}`)).json();
      expect(bob.changes).toHaveLength(1);
      expect(bob.changes[0].hunks).toEqual([{ kind: "add", line: 2, text: "BOB\n" }]);
    });

    it("limits the diff to a time range", async () => {
      const from = new Date(T0 + 15 * MIN).toISOString();
      const res = (await get("owner", `/files/${fileId}/history-diff?userId=${ids.owner}&from=${from}`)).json();
      expect(res.changes.map((c: { hunks: { kind: string }[] }) => c.hunks[0]!.kind)).toEqual(["del"]);
    });

    it("refuses to replay more than the cap, with a clear message", async () => {
      const big = (await prisma.fileNode.create({ data: { projectId, parentId: null, name: "huge.py", type: "FILE" } })).id;
      const tiny = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()));
      await prisma.docEvent.createMany({
        data: Array.from({ length: MAX_REPLAY_EVENTS + 1 }, (_, i) => ({
          fileId: big, userId: ids.owner!, clientId: 7n, clockStart: 0, clockEnd: 0, update: tiny, added: 0, removed: 0,
          startedAt: new Date(T0 + i), createdAt: new Date(T0 + i),
        })),
      });
      const res = await get("owner", `/files/${big}/history-diff?userId=${ids.owner}`);
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ code: "REPLAY_TOO_LARGE", error: expect.stringContaining("at most 20,000") });
      // a smaller range of the same file still works
      const to = new Date(T0 + 100).toISOString();
      expect((await get("owner", `/files/${big}/history-diff?userId=${ids.owner}&to=${to}`)).statusCode).toBe(200);
      await prisma.docEvent.deleteMany({ where: { fileId: big } });
    }, 60_000);

    it("needs a person to filter by, and read access", async () => {
      expect((await get("owner", `/files/${fileId}/history-diff`)).statusCode).toBe(400);
      expect((await get("outsider", `/files/${fileId}/history-diff?userId=${ids.owner}`)).statusCode).toBe(404);
    });
  });

  describe("GET /projects/:id/contributions", () => {
    it("summarises each person: changes, active time, sessions and lines still theirs", async () => {
      const res = await get("viewer", `/projects/${projectId}/contributions`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const owner = body.people.find((p: { id: string }) => p.id === ids.owner);
      const bob = body.people.find((p: { id: string }) => p.id === ids.bob);
      expect(owner).toMatchObject({ added: 8, removed: 4, linesAdded: 2, linesRemoved: 1, sessions: 2, name: "Au owner" });
      expect(bob).toMatchObject({ added: 4 + 8, removed: 0, linesAdded: 2 }); // includes the file that was later deleted
      // the saved text is "two\nBOB\n": one line each
      expect(owner.survivingLines).toBe(1);
      expect(bob.survivingLines).toBe(1);
    });

    it("lists people in order of first activity, not by amount, with one lane per person", async () => {
      const range = `from=${new Date(T0 - MIN).toISOString()}&to=${new Date(T0 + 2 * 60 * MIN).toISOString()}`;
      const body = (await get("owner", `/projects/${projectId}/contributions?${range}`)).json();
      expect(body.people.map((p: { id: string }) => p.id)).toEqual([ids.owner, ids.bob]);
      expect(body.lanes.map((l: { userId: string }) => l.userId)).toEqual([ids.owner, ids.bob]);
      const cells = (id: string | undefined) => body.lanes.find((l: { userId: string }) => l.userId === id).cells;
      expect(cells(ids.owner).length).toBe(cells(ids.bob).length);
      const sum = (cs: { added: number }[]) => cs.reduce((t, c) => t + c.added, 0);
      expect(sum(cells(ids.owner))).toBe(8);
      expect(body.bucketMs).toBe(3_600_000); // a short range gets hourly buckets
      expect(body.truncated).toBe(false);
      // a months-long range (events from March, up to now) gets daily buckets
      expect((await get("owner", `/projects/${projectId}/contributions`)).json().bucketMs).toBe(86_400_000);
    });

    it("can be limited to a range and bucket size", async () => {
      const from = new Date(T0 + 5 * MIN).toISOString();
      const to = new Date(T0 + 15 * MIN).toISOString();
      const body = (await get("owner", `/projects/${projectId}/contributions?from=${from}&to=${to}&bucket=day`)).json();
      expect(body.people.map((p: { id: string }) => p.id)).toEqual([ids.bob]);
      expect(body.bucketMs).toBe(86_400_000);
    });

    it("is available to members only", async () => {
      expect((await get("guest", `/projects/${projectId}/contributions`)).statusCode).toBe(200);
      expect((await get("outsider", `/projects/${projectId}/contributions`)).statusCode).toBe(404);
      expect((await get(null, `/projects/${projectId}/contributions`)).statusCode).toBe(401);
    });
  });

  it("GET /projects/:id/members lists everyone with role, colour and initials", async () => {
    const body = (await get("viewer", `/projects/${projectId}/members`)).json();
    expect(body.map((m: { role: string }) => m.role).sort()).toEqual(["EDITOR", "OWNER", "VIEWER", "VIEWER"]);
    expect(body.find((m: { id: string }) => m.id === ids.guest)).toMatchObject({ isGuest: true, initials: "AG" });
    expect((await get("outsider", `/projects/${projectId}/members`)).statusCode).toBe(404);
  });
});
