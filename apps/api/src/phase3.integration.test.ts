// Guests, invite-only approval, link expiry and the commenter role, against a real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@collabcode/db";
import { MAX_GUESTS_PER_PROJECT } from "@collabcode/shared";
import { buildApp } from "./app";
import { hashShareToken } from "./services/share-links";
import { MAX_PENDING_PER_LINK } from "./services/share-links";

const WEB = "http://localhost:3000";
const run = describe.skipIf(!process.env.DATABASE_URL);
const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;

run("Phase 3: guests, approval, expiry, commenter (integration)", () => {
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const cookies: Record<string, string> = {}; // person -> full Cookie header value
  const ids: Record<string, string> = {};
  const createdUsers: string[] = [];
  let projectId = "";

  async function makeUser(key: string) {
    const token = randomUUID();
    const u = await prisma.user.create({
      data: {
        name: `P3 ${key}`,
        email: `${randomUUID()}@test.local`,
        sessions: { create: { sessionToken: token, expires: new Date(Date.now() + 3_600_000) } },
      },
    });
    createdUsers.push(u.id);
    cookies[key] = `authjs.session-token=${token}`;
    ids[key] = u.id;
  }

  const call = (who: string | null, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, ip = randomIp()) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      remoteAddress: ip, // anonymous rate limits are per IP; give every call its own unless testing that
      headers: { ...(who ? { cookie: cookies[who]! } : {}), origin: WEB },
    });

  const createLink = async (body: Record<string, unknown>, pid = projectId) =>
    (await call("owner", "POST", `/projects/${pid}/share-links`, body)).json();
  const preview = (token: string) => call(null, "POST", "/share-links/preview", { token });
  const join = (who: string | null, token: string) => call(who, "POST", "/share-links/join", { token });
  const joinGuest = (token: string, displayName: string, who: string | null = null, ip?: string) =>
    call(who, "POST", "/share-links/join-guest", { token, displayName }, ip);
  const guestCount = () => prisma.user.count({ where: { isGuest: true, name: { startsWith: "G3-" } } });

  /** Register the guest cookie from a join-guest response under `key`. */
  const adopt = (key: string, res: Awaited<ReturnType<typeof joinGuest>>) => {
    const c = res.cookies.find((x) => x.name === "cc_guest");
    expect(c, "guest cookie").toBeDefined();
    cookies[key] = `cc_guest=${c!.value}`;
    return c!;
  };

  beforeAll(async () => {
    app = await buildApp({ prisma, webOrigin: WEB, collabSecret: "s".repeat(32), collabPublicUrl: "ws://collab.test:1234" });
    await Promise.all(["owner", "bob", "carol", "editor", "other", "acct"].map(makeUser));
    projectId = (await call("owner", "POST", "/projects", { name: "p3", language: "PYTHON" })).json().id;
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { ownerId: { in: createdUsers } } });
    await prisma.user.deleteMany({ where: { OR: [{ id: { in: createdUsers } }, { isGuest: true, name: { startsWith: "G3-" } }] } });
    await prisma.$disconnect();
    await app.close();
  });

  // ------------------------------------------------------------------ expiry

  describe("link expiry", () => {
    it("sets expiry from the server clock for each choice, and defaults to 7 days", async () => {
      const near = (iso: string | null, ms: number) =>
        expect(Math.abs(new Date(iso!).getTime() - (Date.now() + ms))).toBeLessThan(5000);
      near((await createLink({ role: "VIEWER", expiresIn: "1h" })).expiresAt, 3_600_000);
      near((await createLink({ role: "VIEWER", expiresIn: "1d" })).expiresAt, 86_400_000);
      near((await createLink({ role: "VIEWER", expiresIn: "7d" })).expiresAt, 7 * 86_400_000);
      near((await createLink({ role: "VIEWER" })).expiresAt, 7 * 86_400_000);
      expect((await createLink({ role: "VIEWER", expiresIn: "never" })).expiresAt).toBeNull();
    });

    it("ignores any client-supplied timestamp and rejects unknown choices", async () => {
      const res = await call("owner", "POST", `/projects/${projectId}/share-links`, { role: "VIEWER", expiresIn: "forever" });
      expect(res.statusCode).toBe(400);
      const sneaky = await createLink({ role: "VIEWER", expiresIn: "1h", expiresAt: "2999-01-01T00:00:00Z" });
      expect(new Date(sneaky.expiresAt).getFullYear()).toBe(new Date().getFullYear());
    });

    it("an expired link gives a clear 410 for signed-in users, guests and previews, and creates no guest", async () => {
      const link = await createLink({ role: "EDITOR", expiresIn: "1h" });
      await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const before = await guestCount();

      for (const res of [await preview(link.token), await join("bob", link.token), await joinGuest(link.token, "G3-late")]) {
        expect(res.statusCode).toBe(410);
        expect(res.json()).toMatchObject({ code: "LINK_EXPIRED", error: expect.stringMatching(/expired/i) });
      }
      expect(await guestCount()).toBe(before);
      expect((await call("bob", "GET", `/projects/${projectId}`)).statusCode).toBe(404);
    });

    it("expiry is checked against the server clock at the moment of use", async () => {
      const link = await createLink({ role: "VIEWER", expiresIn: "1h" });
      await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() + 800) } });
      expect((await preview(link.token)).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 1000));
      expect((await preview(link.token)).statusCode).toBe(410);
    });

    it("unknown and revoked links stay indistinguishable (404), unlike expired ones", async () => {
      const link = await createLink({ role: "VIEWER" });
      await call("owner", "DELETE", `/projects/${projectId}/share-links/${link.id}`);
      for (const token of [link.token, "Z".repeat(43)]) {
        const res = await preview(token);
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe("LINK_INVALID");
      }
    });

    it("people who joined before a link expired keep their access", async () => {
      const link = await createLink({ role: "VIEWER", expiresIn: "1h" });
      expect((await join("carol", link.token)).json().status).toBe("joined");
      await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call("carol", "GET", `/projects/${projectId}`)).statusCode).toBe(200);
    });

    it("the owner's list still shows expired links (so they can be revoked) with their expiry and approval mode", async () => {
      const link = await createLink({ role: "COMMENTER", expiresIn: "1h", requiresApproval: true });
      await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const list = (await call("owner", "GET", `/projects/${projectId}/share-links`)).json();
      const row = list.find((l: { id: string }) => l.id === link.id);
      expect(row).toMatchObject({ role: "COMMENTER", requiresApproval: true });
      expect(new Date(row.expiresAt).getTime()).toBeLessThan(Date.now());
    });
  });

  // --------------------------------------------------------------- commenter

  describe("commenter links", () => {
    it("grant the COMMENTER role: can read, cannot change files, share, or edit", async () => {
      const link = await createLink({ role: "COMMENTER" });
      expect((await join("editor", link.token)).json()).toMatchObject({ status: "joined", role: "COMMENTER" });
      expect((await call("editor", "GET", `/projects/${projectId}/files`)).statusCode).toBe(200);
      expect((await call("editor", "POST", `/projects/${projectId}/files`, { parentId: null, name: "c.py", type: "FILE" })).statusCode).toBe(403);
      expect((await call("editor", "POST", `/projects/${projectId}/share-links`, { role: "EDITOR" })).statusCode).toBe(403);
      const token = (await call("editor", "GET", `/projects/${projectId}/collab-token`)).json();
      expect(token.role).toBe("COMMENTER"); // the collab server makes this connection read-only
    });
  });

  // ------------------------------------------------------------------ guests

  describe("guest access", () => {
    it("shows what a link grants without needing an account", async () => {
      const link = await createLink({ role: "EDITOR", expiresIn: "1d" });
      const res = await preview(link.token);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ projectName: "p3", ownerName: "P3 owner", role: "EDITOR", requiresApproval: false });
    });

    it("a display name is enough: creates a guest with the link's role and a protected cookie", async () => {
      const link = await createLink({ role: "VIEWER" });
      const res = await joinGuest(link.token, "  G3-Gina   Guest ");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "joined", projectId, role: "VIEWER", joined: true });

      const cookie = adopt("gina", res);
      expect(cookie.httpOnly).toBe(true);
      expect(String(cookie.sameSite).toLowerCase()).toBe("lax");
      expect(cookie.path).toBe("/");

      const user = await prisma.user.findFirstOrThrow({ where: { isGuest: true, name: "G3-Gina Guest" } }); // name normalised
      expect(user.email).toBeNull();
      ids.gina = user.id;
      createdUsers.push(user.id);
      const member = await prisma.projectMember.findUniqueOrThrow({ where: { projectId_userId: { projectId, userId: user.id } } });
      expect(member).toMatchObject({ role: "VIEWER", initials: "GG", viaShareLinkId: link.id });

      // only a hash of the cookie secret is stored
      const sessions = await prisma.guestSession.findMany({ where: { userId: user.id } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.tokenHash).toBe(hashShareToken(cookies.gina!.split("=")[1]!));
      expect(JSON.stringify(sessions)).not.toContain(cookies.gina!.split("=")[1]!);
    });

    it("the guest cookie identifies the guest, who is clearly marked as one", async () => {
      expect((await call("gina", "GET", "/me")).json()).toMatchObject({ id: ids.gina, name: "G3-Gina Guest", isGuest: true });
      expect((await call("gina", "GET", `/projects/${projectId}`)).json().role).toBe("VIEWER");
      const t = (await call("gina", "GET", `/projects/${projectId}/collab-token`)).json();
      expect(t).toMatchObject({ role: "VIEWER", user: { name: "G3-Gina Guest", isGuest: true, initials: "GG" } });
    });

    it("a viewer guest cannot change anything, and sees no other project", async () => {
      expect((await call("gina", "POST", `/projects/${projectId}/files`, { parentId: null, name: "x.py", type: "FILE" })).statusCode).toBe(403);
      expect((await call("gina", "POST", `/projects/${projectId}/share-links`, { role: "VIEWER" })).statusCode).toBe(403);
      expect((await call("gina", "GET", `/projects/${randomUUID()}`)).statusCode).toBe(404);
      const otherProject = (await call("other", "POST", "/projects", { name: "theirs", language: "PYTHON" })).json().id;
      expect((await call("gina", "GET", `/projects/${otherProject}/files`)).statusCode).toBe(404);
      const list = (await call("gina", "GET", "/projects")).json();
      expect(list.mine).toHaveLength(0);
      expect(list.shared.map((p: { id: string }) => p.id)).toEqual([projectId]);
    });

    it("guests can never create projects", async () => {
      const res = await call("gina", "POST", "/projects", { name: "mine", language: "PYTHON" });
      expect(res.statusCode).toBe(403);
    });

    it("an editor-link guest gets exactly the editor role (file tree yes, sharing no)", async () => {
      const link = await createLink({ role: "EDITOR" });
      const res = await joinGuest(link.token, "G3-Ed");
      adopt("ed", res);
      createdUsers.push((await prisma.user.findFirstOrThrow({ where: { name: "G3-Ed" } })).id);
      expect(res.json().role).toBe("EDITOR");
      expect((await call("ed", "POST", `/projects/${projectId}/files`, { parentId: null, name: "g.py", type: "FILE" })).statusCode).toBe(201);
      expect((await call("ed", "POST", `/projects/${projectId}/share-links`, { role: "EDITOR" })).statusCode).toBe(403);
      expect((await call("ed", "DELETE", `/projects/${projectId}`)).statusCode).toBe(403);
    });

    it("validates the display name and link before creating anything", async () => {
      const link = await createLink({ role: "VIEWER" });
      const before = await guestCount();
      for (const name of ["", "   ", "x".repeat(41), "a\u0000b", "evil\u202egpj"]) {
        expect((await joinGuest(link.token, name)).statusCode, JSON.stringify(name)).toBe(400);
      }
      expect((await joinGuest("short", "G3-Nope")).statusCode).toBe(400);
      expect((await joinGuest("Z".repeat(43), "G3-Nope")).statusCode).toBe(404);
      expect(await guestCount()).toBe(before);
    });

    it("someone who already has an identity is not turned into a second guest", async () => {
      const link = await createLink({ role: "COMMENTER" });
      const before = await guestCount();
      const asGuest = await joinGuest(link.token, "G3-Again", "gina"); // gina has a cookie
      expect(asGuest.statusCode).toBe(200);
      expect(asGuest.json()).toMatchObject({ status: "joined", joined: false, role: "VIEWER" }); // keeps her role
      const asUser = await joinGuest(link.token, "G3-Again", "acct"); // signed-in account: a normal join, no guest created
      expect(asUser.json()).toMatchObject({ status: "joined", role: "COMMENTER", joined: true });
      expect(await guestCount()).toBe(before);
    });

    it("logging out ends the guest session; an expired guest session stops working", async () => {
      const link = await createLink({ role: "VIEWER" });
      const res = await joinGuest(link.token, "G3-Temp");
      adopt("temp", res);
      const u = await prisma.user.findFirstOrThrow({ where: { name: "G3-Temp" } });
      createdUsers.push(u.id);
      expect((await call("temp", "GET", "/me")).statusCode).toBe(200);

      await prisma.guestSession.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await call("temp", "GET", "/me")).statusCode).toBe(401);
      await prisma.guestSession.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
      expect((await call("temp", "GET", "/me")).statusCode).toBe(200);

      expect((await call("temp", "POST", "/guest/logout")).statusCode).toBe(204);
      expect((await call("temp", "GET", "/me")).statusCode).toBe(401);
      expect(await prisma.guestSession.count({ where: { userId: u.id } })).toBe(0);
    });

    it("a forged or malformed guest cookie is just 'not signed in'", async () => {
      cookies.fake = `cc_guest=${"A".repeat(43)}`;
      expect((await call("fake", "GET", "/me")).statusCode).toBe(401);
      cookies.fake2 = "cc_guest=";
      expect((await call("fake2", "GET", "/projects")).statusCode).toBe(401);
    });

    it("caps the number of guests per project", async () => {
      const limited = (await call("owner", "POST", "/projects", { name: "capped", language: "PYTHON" })).json().id;
      const link = await createLink({ role: "VIEWER" }, limited);
      const users = await Promise.all(
        Array.from({ length: MAX_GUESTS_PER_PROJECT }, (_, i) =>
          prisma.user.create({ data: { name: `G3-fill-${i}`, isGuest: true } }),
        ),
      );
      createdUsers.push(...users.map((u) => u.id));
      await prisma.projectMember.createMany({
        data: users.map((u, i) => ({ projectId: limited, userId: u.id, role: "VIEWER" as const, color: "#999999", initials: `F${i}` })),
      });
      const before = await guestCount();
      const res = await joinGuest(link.token, "G3-OneTooMany");
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("GUEST_LIMIT");
      expect(await guestCount()).toBe(before); // and no stray guest row was created
      // an account holder can still join
      expect((await join("bob", link.token)).json()).toMatchObject({ status: "joined", role: "VIEWER" });
    });

    it("rate limits the anonymous guest endpoint per IP, but not so tightly that a class cannot join together", async () => {
      const link = await createLink({ role: "VIEWER" });
      const ip = "203.0.113.77";
      const statuses: number[] = [];
      for (let i = 0; i < 70; i++) statuses.push((await joinGuest(link.token, "x".repeat(41), null, ip)).statusCode); // cheap 400s
      expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true); // 30 people at once are fine
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0); // a flood is not
      // a different address is unaffected
      expect((await joinGuest(link.token, "x".repeat(41), null, "203.0.113.78")).statusCode).toBe(400);
    });

    it("the link preview is throttled per link, not shared by every visitor", async () => {
      const a = await createLink({ role: "VIEWER" });
      const b = await createLink({ role: "VIEWER" });
      const same = "198.51.100.9"; // the web server's address: every visitor looks like this one
      for (let i = 0; i < 125; i++) await call(null, "POST", "/share-links/preview", { token: a.token }, same);
      expect((await call(null, "POST", "/share-links/preview", { token: a.token }, same)).statusCode).toBe(429);
      expect((await call(null, "POST", "/share-links/preview", { token: b.token }, same)).statusCode).toBe(200);
    });
  });

  // ------------------------------------------------------- invite-only links

  describe("invite-only links (owner approval)", () => {
    let invite: { id: string; token: string };
    const pendingList = async () => (await call("owner", "GET", `/projects/${projectId}/join-requests`)).json();

    it("joining creates ONE pending request and no membership", async () => {
      invite = await createLink({ role: "EDITOR", requiresApproval: true });
      expect((await preview(invite.token)).json().requiresApproval).toBe(true);

      expect((await join("bob", invite.token)).json()).toEqual({ status: "pending" });
      expect((await join("bob", invite.token)).json()).toEqual({ status: "pending" }); // asking again is harmless
      expect(await prisma.joinRequest.count({ where: { shareLinkId: invite.id, userId: ids.bob } })).toBe(1);
      expect((await call("bob", "GET", `/projects/${projectId}`)).statusCode).toBe(404); // still outside
      expect((await call("bob", "GET", `/projects/${projectId}/collab-token`)).statusCode).toBe(404);
    });

    it("the owner sees pending requests with who is asking and which role they would get", async () => {
      const list = await pendingList();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ role: "EDITOR", requester: { id: ids.bob, name: "P3 bob", isGuest: false } });
    });

    it("only the owner can see or decide requests", async () => {
      const req = (await pendingList())[0].id;
      // 'editor' is a COMMENTER member, 'other' is a stranger, 'bob' is the requester himself
      for (const [who, status] of [["editor", 403], ["other", 404], ["bob", 404], [null, 401]] as const) {
        expect((await call(who, "GET", `/projects/${projectId}/join-requests`)).statusCode, `list ${who}`).toBe(status);
        expect((await call(who, "POST", `/projects/${projectId}/join-requests/${req}/approve`)).statusCode, `approve ${who}`).toBe(status);
        expect((await call(who, "POST", `/projects/${projectId}/join-requests/${req}/reject`)).statusCode, `reject ${who}`).toBe(status);
      }
      expect((await call("bob", "GET", `/projects/${projectId}`)).statusCode).toBe(404); // nothing slipped through
    });

    it("an owner of ANOTHER project cannot decide this project's requests", async () => {
      const theirs = (await call("other", "POST", "/projects", { name: "theirs2", language: "PYTHON" })).json().id;
      const req = (await pendingList())[0].id;
      expect((await call("other", "POST", `/projects/${theirs}/join-requests/${req}/approve`)).statusCode).toBe(404);
      expect((await call("bob", "GET", `/projects/${projectId}`)).statusCode).toBe(404);
    });

    it("approving makes the requester a member with the LINK's role, once", async () => {
      const req = (await pendingList())[0].id;
      expect((await call("owner", "POST", `/projects/${projectId}/join-requests/${req}/approve`)).statusCode).toBe(204);
      expect((await call("owner", "POST", `/projects/${projectId}/join-requests/${req}/approve`)).statusCode).toBe(409);
      expect((await call("owner", "POST", `/projects/${projectId}/join-requests/${req}/reject`)).statusCode).toBe(409);
      expect(await pendingList()).toHaveLength(0);

      expect((await join("bob", invite.token)).json()).toMatchObject({ status: "joined", role: "EDITOR" });
      expect((await call("bob", "GET", `/projects/${projectId}`)).json().role).toBe("EDITOR");
    });

    it("rejecting keeps the person out, and they cannot simply ask again", async () => {
      const link = await createLink({ role: "VIEWER", requiresApproval: true });
      expect((await join("other", link.token)).json()).toEqual({ status: "pending" });
      const req = (await pendingList()).find((r: { requester: { id: string } }) => r.requester.id === ids.other).id;
      expect((await call("owner", "POST", `/projects/${projectId}/join-requests/${req}/reject`)).statusCode).toBe(204);

      for (let i = 0; i < 2; i++) {
        const res = await join("other", link.token);
        expect(res.statusCode).toBe(403);
        expect(res.json().code).toBe("JOIN_DENIED");
      }
      expect((await call("other", "GET", `/projects/${projectId}`)).statusCode).toBe(404);
      expect(await pendingList()).toHaveLength(0);
    });

    it("guests go through approval too, and keep the same identity afterwards", async () => {
      const link = await createLink({ role: "COMMENTER", requiresApproval: true });
      const res = await joinGuest(link.token, "G3-Waiting");
      expect(res.json()).toEqual({ status: "pending" });
      adopt("waiting", res);
      const u = await prisma.user.findFirstOrThrow({ where: { name: "G3-Waiting" } });
      createdUsers.push(u.id);

      expect((await call("waiting", "GET", `/projects/${projectId}`)).statusCode).toBe(404); // not in yet
      const pending = (await pendingList()).find((r: { requester: { id: string } }) => r.requester.id === u.id);
      expect(pending).toMatchObject({ role: "COMMENTER", requester: { name: "G3-Waiting", isGuest: true } });

      expect((await call("waiting", "POST", "/share-links/join", { token: link.token })).json()).toEqual({ status: "pending" });
      await call("owner", "POST", `/projects/${projectId}/join-requests/${pending.id}/approve`);
      expect((await call("waiting", "POST", "/share-links/join", { token: link.token })).json()).toMatchObject({ status: "joined", role: "COMMENTER" });
      expect((await call("waiting", "GET", `/projects/${projectId}`)).json().role).toBe("COMMENTER");
    });

    it("existing members and the owner never create requests", async () => {
      const before = await prisma.joinRequest.count({ where: { shareLinkId: invite.id } });
      expect((await join("owner", invite.token)).json()).toMatchObject({ status: "joined", role: "OWNER", joined: false });
      expect((await join("bob", invite.token)).json()).toMatchObject({ status: "joined", joined: false });
      expect(await prisma.joinRequest.count({ where: { shareLinkId: invite.id } })).toBe(before);
    });

    it("revoking a link declines its pending requests, which can then no longer be approved", async () => {
      const link = await createLink({ role: "EDITOR", requiresApproval: true });
      await makeUser("late");
      expect((await join("late", link.token)).json()).toEqual({ status: "pending" });
      const req = (await pendingList()).find((r: { requester: { id: string } }) => r.requester.id === ids.late).id;

      await call("owner", "DELETE", `/projects/${projectId}/share-links/${link.id}`);
      expect(await pendingList()).toHaveLength(0);
      expect((await call("owner", "POST", `/projects/${projectId}/join-requests/${req}/approve`)).statusCode).toBe(409);
      expect((await join("late", link.token)).statusCode).toBe(404);
      expect((await call("late", "GET", `/projects/${projectId}`)).statusCode).toBe(404);
    });

    it("an expired invite link no longer accepts new requests", async () => {
      const link = await createLink({ role: "VIEWER", requiresApproval: true, expiresIn: "1h" });
      await prisma.shareLink.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1) } });
      await makeUser("later");
      const res = await join("later", link.token);
      expect(res.statusCode).toBe(410);
      expect(await prisma.joinRequest.count({ where: { shareLinkId: link.id } })).toBe(0);
    });

    it("caps pending requests per link so a leaked link can't flood the owner", async () => {
      const link = await createLink({ role: "VIEWER", requiresApproval: true });
      await prisma.joinRequest.createMany({
        data: Array.from({ length: MAX_PENDING_PER_LINK }, (_, i) => ({ shareLinkId: link.id, userId: `fake-${randomUUID()}-${i}` })),
      });
      await makeUser("flood");
      const before = await guestCount();
      expect((await join("flood", link.token)).statusCode).toBe(429);
      expect((await joinGuest(link.token, "G3-Flood")).statusCode).toBe(429);
      expect(await guestCount()).toBe(before); // the rejected guest left no row behind
    });
  });
});
