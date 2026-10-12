// Runs against a real Postgres (set DATABASE_URL and apply migrations first).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@collabcode/db";
import { buildApp } from "./app";

const WEB = "http://localhost:3000";
const run = describe.skipIf(!process.env.DATABASE_URL);

run("REST API (integration)", () => {
  const prisma = new PrismaClient();
  let app: Awaited<ReturnType<typeof buildApp>>;
  const created: string[] = []; // user ids to clean up
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  async function makeUser(key: string) {
    const token = randomUUID();
    const u = await prisma.user.create({
      data: {
        name: `Test ${key}`,
        email: `${randomUUID()}@test.local`,
        sessions: { create: { sessionToken: token, expires: new Date(Date.now() + 3_600_000) } },
      },
    });
    created.push(u.id);
    cookies[key] = `authjs.session-token=${token}`;
    ids[key] = u.id;
  }

  const call = (who: string | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object | undefined,
      headers: { ...(who ? { cookie: cookies[who]! } : {}), origin: WEB },
    });

  beforeAll(async () => {
    app = await buildApp({ prisma, webOrigin: WEB });
    await Promise.all(["owner", "editor", "viewer", "outsider"].map(makeUser));
  });

  afterAll(async () => {
    await prisma.project.deleteMany({ where: { ownerId: { in: created } } });
    await prisma.user.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
    await app.close();
  });

  let projectId = "";

  it("rejects unauthenticated requests", async () => {
    expect((await call(null, "GET", "/projects")).statusCode).toBe(401);
  });

  it("rejects writes from another origin (CSRF)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "x", language: "PYTHON" },
      headers: { cookie: cookies.owner!, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("validates project input", async () => {
    expect((await call("owner", "POST", "/projects", { name: "", language: "PYTHON" })).statusCode).toBe(400);
    expect((await call("owner", "POST", "/projects", { name: "ok", language: "BRAINFUCK" })).statusCode).toBe(400);
  });

  it("creates a project with an owner membership and the default entry file", async () => {
    const res = await call("owner", "POST", "/projects", { name: "My Java app", language: "JAVA" });
    expect(res.statusCode).toBe(201);
    projectId = res.json().id;
    const files = (await call("owner", "GET", `/projects/${projectId}/files`)).json();
    expect(files.map((f: { name: string }) => f.name)).toEqual(["Main.java"]);
    const detail = (await call("owner", "GET", `/projects/${projectId}`)).json();
    expect(detail.role).toBe("OWNER");
  });

  it("lists my projects vs shared projects", async () => {
    await prisma.projectMember.create({
      data: { projectId, userId: ids.editor!, role: "EDITOR", color: "#56B4E9", initials: "TE" },
    });
    await prisma.projectMember.create({
      data: { projectId, userId: ids.viewer!, role: "VIEWER", color: "#009E73", initials: "TV" },
    });
    const owner = (await call("owner", "GET", "/projects")).json();
    expect(owner.mine.map((p: { id: string }) => p.id)).toContain(projectId);
    expect(owner.shared).toHaveLength(0);
    const editor = (await call("editor", "GET", "/projects")).json();
    expect(editor.mine).toHaveLength(0);
    expect(editor.shared.map((p: { id: string }) => p.id)).toEqual([projectId]);
    expect(editor.shared[0].role).toBe("EDITOR");
  });

  it("hides the project from non-members", async () => {
    expect((await call("outsider", "GET", `/projects/${projectId}`)).statusCode).toBe(404);
    expect((await call("outsider", "GET", `/projects/${projectId}/files`)).statusCode).toBe(404);
  });

  it("lets viewers read but not change the file tree", async () => {
    expect((await call("viewer", "GET", `/projects/${projectId}/files`)).statusCode).toBe(200);
    const res = await call("viewer", "POST", `/projects/${projectId}/files`, { parentId: null, name: "x.java", type: "FILE" });
    expect(res.statusCode).toBe(403);
  });

  it("only the owner can rename or delete the project", async () => {
    expect((await call("editor", "PATCH", `/projects/${projectId}`, { name: "hijack" })).statusCode).toBe(403);
    expect((await call("editor", "DELETE", `/projects/${projectId}`)).statusCode).toBe(403);
    expect((await call("owner", "PATCH", `/projects/${projectId}`, { name: "Renamed" })).statusCode).toBe(200);
  });

  let folderId = "";
  let fileId = "";

  it("creates folders and files, and rejects duplicates and bad parents", async () => {
    const folder = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: null, name: "src", type: "FOLDER" });
    expect(folder.statusCode).toBe(201);
    folderId = folder.json().id;
    const file = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: folderId, name: "Util.java", type: "FILE" });
    expect(file.statusCode).toBe(201);
    fileId = file.json().id;

    const dup = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: folderId, name: "Util.java", type: "FILE" });
    expect(dup.statusCode).toBe(409);
    const dupTop = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: null, name: "src", type: "FOLDER" });
    expect(dupTop.statusCode).toBe(409); // top-level duplicates must be caught too (NULL parent)

    const underFile = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: fileId, name: "a", type: "FILE" });
    expect(underFile.statusCode).toBe(400);
    const badName = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: null, name: "../etc", type: "FILE" });
    expect(badName.statusCode).toBe(400);
  });

  it("does not let a parent from another project be used", async () => {
    const other = await call("outsider", "POST", "/projects", { name: "other", language: "PYTHON" });
    const otherProject = other.json().id;
    const res = await call("editor", "POST", `/projects/${otherProject}/files`, { parentId: folderId, name: "x", type: "FILE" });
    expect(res.statusCode).toBe(404); // editor is not a member of the other project at all
    const sneaky = await call("outsider", "POST", `/projects/${otherProject}/files`, { parentId: folderId, name: "x", type: "FILE" });
    expect(sneaky.statusCode).toBe(400); // folderId belongs to a different project
  });

  it("renames, and rejects rename onto an existing sibling", async () => {
    await call("editor", "POST", `/projects/${projectId}/files`, { parentId: folderId, name: "Other.java", type: "FILE" });
    expect((await call("editor", "PATCH", `/files/${fileId}`, { name: "Other.java" })).statusCode).toBe(409);
    const ok = await call("editor", "PATCH", `/files/${fileId}`, { name: "Helpers.java" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().name).toBe("Helpers.java");
  });

  it("blocks viewers and outsiders from renaming or deleting files", async () => {
    expect((await call("viewer", "PATCH", `/files/${fileId}`, { name: "zzz" })).statusCode).toBe(403);
    expect((await call("viewer", "DELETE", `/files/${fileId}`)).statusCode).toBe(403);
    expect((await call("outsider", "DELETE", `/files/${fileId}`)).statusCode).toBe(404);
  });

  it("validates the entry file and resets it when that file is deleted", async () => {
    expect((await call("owner", "PATCH", `/projects/${projectId}`, { entryFile: "nope.java" })).statusCode).toBe(400);
    expect((await call("owner", "PATCH", `/projects/${projectId}`, { entryFile: "src/Helpers.java" })).statusCode).toBe(200);
    expect((await call("editor", "DELETE", `/files/${fileId}`)).statusCode).toBe(204);
    const detail = (await call("owner", "GET", `/projects/${projectId}`)).json();
    expect(detail.entryFile).toBeNull();
  });

  it("deleting a folder removes its contents, and the name can be reused", async () => {
    expect((await call("editor", "DELETE", `/files/${folderId}`)).statusCode).toBe(204);
    const names = (await call("owner", "GET", `/projects/${projectId}/files`)).json().map((f: { name: string }) => f.name);
    expect(names).toEqual(["Main.java"]);
    const again = await call("editor", "POST", `/projects/${projectId}/files`, { parentId: null, name: "src", type: "FOLDER" });
    expect(again.statusCode).toBe(201); // soft-deleted names don't block reuse
  });

  it("owner can delete the project", async () => {
    expect((await call("owner", "DELETE", `/projects/${projectId}`)).statusCode).toBe(204);
    expect((await call("owner", "GET", `/projects/${projectId}`)).statusCode).toBe(404);
  });
});
