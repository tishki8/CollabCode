import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@collabcode/db";
import { requireAction } from "./access";

// A tiny fake exposing just the call requireAction makes.
const fakePrisma = (role: string | null) =>
  ({ projectMember: { findUnique: async () => (role ? { role } : null) } }) as unknown as PrismaClient;

describe("requireAction", () => {
  it("hides the project from non-members (404, not 403)", async () => {
    await expect(requireAction(fakePrisma(null), "p", "u", "project:read")).rejects.toMatchObject({ statusCode: 404 });
  });
  it("returns 403 when a member lacks the permission", async () => {
    await expect(requireAction(fakePrisma("VIEWER"), "p", "u", "file:manage")).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireAction(fakePrisma("EDITOR"), "p", "u", "project:delete")).rejects.toMatchObject({ statusCode: 403 });
  });
  it("returns the role when allowed", async () => {
    await expect(requireAction(fakePrisma("EDITOR"), "p", "u", "file:manage")).resolves.toBe("EDITOR");
  });
});
