import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@collabcode/db";
import { signCollabToken } from "@collabcode/shared/collab-token";
import { authorize, parseDocumentName, sanitizeAwarenessState, type ConnContext } from "./auth";

const SECRET = "test-secret-test-secret-test-secret";

// Minimal fake of the two Prisma calls authorize() makes.
function fakePrisma(opts: { file?: { projectId: string } | null; member?: { role: string } | null; guest?: boolean }) {
  return {
    fileNode: { findFirst: async () => opts.file ?? null },
    projectMember: {
      findUnique: async () =>
        opts.member ? { ...opts.member, color: "#E69F00", initials: "AD", user: { id: "u1", name: "Alice Demo", isGuest: opts.guest ?? false } } : null,
    },
  } as unknown as PrismaClient;
}

const run = async (prisma: PrismaClient, documentName: string, token?: string) =>
  authorize({ prisma, secret: SECRET, token, documentName });

describe("parseDocumentName", () => {
  it("accepts file and presence rooms only", () => {
    expect(parseDocumentName("file:abc_123")).toEqual({ kind: "file", fileId: "abc_123" });
    expect(parseDocumentName("presence:demo-project")).toEqual({ kind: "presence", projectId: "demo-project" });
  });
  it.each(["", "abc", "file:", "file:a/b", "file:a b", "other:abc", "file:" + "x".repeat(65)])("rejects %j", (n) => {
    expect(parseDocumentName(n)).toBeNull();
  });
});

describe("authorize", () => {
  it("rejects a missing, forged or wrongly-signed token", async () => {
    const p = fakePrisma({ file: { projectId: "p" }, member: { role: "OWNER" } });
    await expect(run(p, "file:f1", undefined)).rejects.toThrow("permission-denied");
    await expect(run(p, "file:f1", "not-a-jwt")).rejects.toThrow("permission-denied");
    const forged = await signCollabToken("u1", "some-other-secret-some-other-secret");
    await expect(run(p, "file:f1", forged)).rejects.toThrow("permission-denied");
  });

  it("rejects malformed document names even with a valid token", async () => {
    const token = await signCollabToken("u1", SECRET);
    const p = fakePrisma({ file: { projectId: "p" }, member: { role: "OWNER" } });
    await expect(run(p, "../../etc", token)).rejects.toThrow("permission-denied");
  });

  it("rejects non-members and missing/deleted files with the same error", async () => {
    const token = await signCollabToken("u1", SECRET);
    await expect(run(fakePrisma({ file: { projectId: "p" }, member: null }), "file:f1", token)).rejects.toThrow("permission-denied");
    await expect(run(fakePrisma({ file: null, member: { role: "OWNER" } }), "file:f1", token)).rejects.toThrow("permission-denied");
  });

  it("makes viewers and commenters read-only, and lets editors and owners write", async () => {
    const token = await signCollabToken("u1", SECRET);
    for (const [role, readOnly] of [["VIEWER", true], ["COMMENTER", true], ["EDITOR", false], ["OWNER", false]] as const) {
      const r = await run(fakePrisma({ file: { projectId: "p" }, member: { role } }), "file:f1", token);
      expect(r.readOnly, role).toBe(readOnly);
      expect(r.context.role).toBe(role);
    }
  });

  it("takes the displayed identity from the database", async () => {
    const token = await signCollabToken("u1", SECRET);
    const r = await run(fakePrisma({ file: { projectId: "p" }, member: { role: "EDITOR" } }), "file:f1", token);
    expect(r.context.user).toEqual({ id: "u1", name: "Alice Demo", color: "#E69F00", initials: "AD", isGuest: false });
  });

  it("guests get exactly their role's rights: read-only for viewer/commenter, writable for editor", async () => {
    const token = await signCollabToken("u1", SECRET);
    for (const [role, readOnly] of [["VIEWER", true], ["COMMENTER", true], ["EDITOR", false]] as const) {
      const r = await run(fakePrisma({ file: { projectId: "p" }, member: { role }, guest: true }), "file:f1", token);
      expect(r.readOnly, `guest ${role}`).toBe(readOnly);
      expect(r.context.user.isGuest).toBe(true); // so cursors and presence can mark them as guests
    }
  });

  it("presence rooms are always read-only, even for owners", async () => {
    const token = await signCollabToken("u1", SECRET);
    const r = await run(fakePrisma({ member: { role: "OWNER" } }), "presence:p", token);
    expect(r.readOnly).toBe(true);
    expect(r.context.projectId).toBe("p");
  });
});

describe("sanitizeAwarenessState", () => {
  const ctx: ConnContext = {
    userId: "u1",
    projectId: "p",
    role: "EDITOR",
    user: { id: "u1", name: "Alice Demo", color: "#E69F00", initials: "AD", isGuest: false },
  };

  it("overwrites a spoofed identity and drops unknown keys", () => {
    const state: Record<string, unknown> = {
      user: { name: "Bob (admin)", color: "red", initials: "BA" },
      selection: { anchor: 1, head: 2 },
      evil: "x".repeat(10_000),
    };
    sanitizeAwarenessState(state, ctx);
    expect(state.user).toEqual(ctx.user);
    expect(state.selection).toEqual({ anchor: 1, head: 2 });
    expect(state).not.toHaveProperty("evil");
  });

  it("adds the identity when the client sent none, and validates fileId", () => {
    const a: Record<string, unknown> = { fileId: "file-1" };
    sanitizeAwarenessState(a, ctx);
    expect(a).toEqual({ fileId: "file-1", user: ctx.user });
    const b: Record<string, unknown> = { fileId: "<script>" };
    sanitizeAwarenessState(b, ctx);
    expect(b).not.toHaveProperty("fileId");
  });

  it("drops oversized or non-object selections", () => {
    const big: Record<string, unknown> = { selection: { anchor: "x".repeat(5000), head: 1 } };
    sanitizeAwarenessState(big, ctx);
    expect(big).not.toHaveProperty("selection");
    const str: Record<string, unknown> = { selection: "not an object" };
    sanitizeAwarenessState(str, ctx);
    expect(str).not.toHaveProperty("selection");
  });

  it("ignores null states (a client leaving)", () => {
    expect(() => sanitizeAwarenessState(null, ctx)).not.toThrow();
  });
});
