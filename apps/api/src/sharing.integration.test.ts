// Share links + collab tokens against a real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@collabcode/db";
import { verifyCollabToken } from "@collabcode/shared/collab-token";
import { buildApp } from "./app";
import { hashShareToken, newShareToken } from "./services/share-links";

const WEB = "http://localhost:3000";
const SECRET = "s".repeat(32);
const run = describe.skipIf(!process.env.DATABASE_URL);

run("share links and collab tokens (integration)", () => {
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let projectId = "";

  async function makeUser(key: string) {
    const token = randomUUID();
    const u = await prisma.user.create({
      data: {
        name: `Share ${key}`,
        email: `${randomUUID()}@test.local`,
        sessions: { create: { sessionToken: token, expires: new Date(Date.now() + 3_600_000) } },
      },
    });
    cookies[key] = `authjs.session-token=${token}`;
    ids[key] = u.id;
  }

  const call = (who: string | null, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: { ...(who ? { cookie: cookies[who]! } : {}), origin: WEB },
    });

  const createLink = async (role: string) => (await call("owner", "POST", `/projects/${projectId}/share-links`, { role })).json();
  const join = (who: string | null, token: string) => call(who, "POST", "/share-links/join", { token });

  beforeAll(async () => {
    app = await buildApp({ prisma, webOrigin: WEB, collabSecret: SECRET, collabPublicUrl: "ws://collab.test:1234" });
    await Promise.all(["owner", "bob", "carol", "dave", "outsider"].map(makeUser));
    const res = await call("owner", "POST", "/projects", { name: "shared", language: "PYTHON" });
    projectId = res.json().id;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { ownerId: ids.owner } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.$disconnect();
    await app.close();
  });

  it("tokens are random, url-safe and stored only as a hash", async () => {
    const t = newShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newShareToken()).not.toBe(t);
    const link = await createLink("EDITOR");
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await prisma.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(hashShareToken(link.token));
    expect(JSON.stringify(row)).not.toContain(link.token);
  });

  it("only the owner can create, list or revoke links", async () => {
    const link = await createLink("VIEWER");
    // make Bob an editor so he is a real member who must still be refused
    await join("bob", (await createLink("EDITOR")).token);
    for (const who of ["bob", "outsider"]) {
      const expected = who === "bob" ? 403 : 404;
      expect((await call(who, "POST", `/projects/${projectId}/share-links`, { role: "EDITOR" })).statusCode).toBe(expected);
      expect((await call(who, "GET", `/projects/${projectId}/share-links`)).statusCode).toBe(expected);
      expect((await call(who, "DELETE", `/projects/${projectId}/share-links/${link.id}`)).statusCode).toBe(expected);
    }
    expect((await call(null, "POST", `/projects/${projectId}/share-links`, { role: "EDITOR" })).statusCode).toBe(401);
  });

  it("rejects roles a link may not grant in this phase", async () => {
    for (const role of ["OWNER", "COMMENTER", "ADMIN", ""]) {
      expect((await call("owner", "POST", `/projects/${projectId}/share-links`, { role })).statusCode, role).toBe(400);
    }
  });

  it("an editor link makes the opener an editor with a colour and initials", async () => {
    const link = await createLink("EDITOR");
    const res = await join("carol", link.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ projectId, role: "EDITOR", joined: true });
    const member = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: ids.carol! } },
    });
    expect(member.role).toBe("EDITOR");
    expect(member.initials).toBe("SC");
    expect(member.viaShareLinkId).toBe(link.id);
    // the new member can now see the project and its files, and may change the tree
    expect((await call("carol", "GET", `/projects/${projectId}`)).json().role).toBe("EDITOR");
    expect((await call("carol", "POST", `/projects/${projectId}/files`, { parentId: null, name: "c.py", type: "FILE" })).statusCode).toBe(201);
  });

  it("a viewer link makes the opener a viewer who can read but not change anything", async () => {
    const link = await createLink("VIEWER");
    expect((await join("dave", link.token)).json()).toMatchObject({ role: "VIEWER", joined: true });
    expect((await call("dave", "GET", `/projects/${projectId}/files`)).statusCode).toBe(200);
    expect((await call("dave", "POST", `/projects/${projectId}/files`, { parentId: null, name: "d.py", type: "FILE" })).statusCode).toBe(403);
    expect((await call("dave", "POST", `/projects/${projectId}/share-links`, { role: "EDITOR" })).statusCode).toBe(403);
  });

  it("members get distinct colours", async () => {
    const colors = (await prisma.projectMember.findMany({ where: { projectId } })).map((m) => m.color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("opening a link again, or with another link, never changes an existing role", async () => {
    const viewerLink = await createLink("VIEWER");
    const again = await join("carol", viewerLink.token); // carol is an EDITOR: must not be downgraded
    expect(again.json()).toEqual({ projectId, role: "EDITOR", joined: false });
    const ownerOpens = await join("owner", viewerLink.token);
    expect(ownerOpens.json()).toEqual({ projectId, role: "OWNER", joined: false });
    const editorLink = await createLink("EDITOR");
    expect((await join("dave", editorLink.token)).json()).toMatchObject({ role: "VIEWER", joined: false }); // no silent upgrade
  });

  it("requires sign-in and a well-formed token", async () => {
    const link = await createLink("VIEWER");
    expect((await join(null, link.token)).statusCode).toBe(401);
    expect((await join("outsider", "short")).statusCode).toBe(400);
    expect((await join("outsider", "../../etc/passwd/../../etc/passwd/")).statusCode).toBe(400);
    expect((await join("outsider", "A".repeat(43))).statusCode).toBe(404); // well-formed but unknown
    expect((await call("outsider", "GET", `/projects/${projectId}`)).statusCode).toBe(404); // joined nothing
  });

  it("a revoked link stops working but keeps already-joined members", async () => {
    const link = await createLink("EDITOR");
    expect((await call("owner", "GET", `/projects/${projectId}/share-links`)).json().map((l: { id: string }) => l.id)).toContain(link.id);
    expect((await call("owner", "DELETE", `/projects/${projectId}/share-links/${link.id}`)).statusCode).toBe(204);
    expect((await call("owner", "DELETE", `/projects/${projectId}/share-links/${link.id}`)).statusCode).toBe(204); // idempotent
    expect((await call("owner", "GET", `/projects/${projectId}/share-links`)).json().map((l: { id: string }) => l.id)).not.toContain(link.id);

    const res = await join("outsider", link.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/invalid or has been revoked/);
    expect((await call("outsider", "GET", `/projects/${projectId}`)).statusCode).toBe(404);

    // someone who joined through it earlier is unaffected
    const link2 = await createLink("VIEWER");
    await prisma.user.create({ data: { id: "extra-" + randomUUID(), name: "x" } }).then(async (u) => {
      await prisma.projectMember.create({
        data: { projectId, userId: u.id, role: "VIEWER", color: "#999999", initials: "X", viaShareLinkId: link2.id },
      });
      await call("owner", "DELETE", `/projects/${projectId}/share-links/${link2.id}`);
      expect(await prisma.projectMember.count({ where: { projectId, userId: u.id } })).toBe(1);
      await prisma.user.delete({ where: { id: u.id } });
    });
  });

  it("cannot revoke a link through a different project", async () => {
    const other = (await call("outsider", "POST", "/projects", { name: "other", language: "PYTHON" })).json().id;
    const link = await createLink("VIEWER");
    expect((await call("outsider", "DELETE", `/projects/${other}/share-links/${link.id}`)).statusCode).toBe(404);
    expect((await prisma.shareLink.findUniqueOrThrow({ where: { id: link.id } })).revokedAt).toBeNull();
    await prisma.project.delete({ where: { id: other } });
  });

  it("expired links (reserved for Phase 3) are refused too", async () => {
    const link = await createLink("VIEWER");
    await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await join("outsider", link.token)).statusCode).toBe(404);
  });

  describe("collab token", () => {
    it("is issued to members with their identity, and the collab server can verify it", async () => {
      const res = await call("carol", "GET", `/projects/${projectId}/collab-token`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.url).toBe("ws://collab.test:1234");
      expect(body.role).toBe("EDITOR");
      expect(body.user).toMatchObject({ id: ids.carol, name: "Share carol", initials: "SC" });
      expect(body.user.color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(await verifyCollabToken(body.token, SECRET)).toBe(ids.carol);
      await expect(verifyCollabToken(body.token, "z".repeat(32))).rejects.toThrow();
    });
    it("is refused to non-members and anonymous callers", async () => {
      expect((await call("outsider", "GET", `/projects/${projectId}/collab-token`)).statusCode).toBe(404);
      expect((await call(null, "GET", `/projects/${projectId}/collab-token`)).statusCode).toBe(401);
    });
  });

  it("rate limits are per signed-in user, so teammates on one IP do not throttle each other", async () => {
    // Everything here comes from the same (inject) IP address.
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const res = await call("bob", "GET", `/projects/${projectId}/collab-token`);
      if (res.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0); // Bob exceeded his own budget (120/min)...
    expect((await call("carol", "GET", `/projects/${projectId}/collab-token`)).statusCode).toBe(200); // ...Carol is unaffected
    expect((await call("owner", "GET", `/projects/${projectId}`)).statusCode).toBe(200);
  });
});
