import { describe, expect, it } from "vitest";
import { ACTIONS, ROLES, can, type Action } from "./permissions";

describe("permission matrix", () => {
  it("denies everything when there is no role", () => {
    for (const a of ACTIONS) {
      expect(can(null, a)).toBe(false);
      expect(can(undefined, a)).toBe(false);
    }
  });

  it("denies unknown roles (deny by default)", () => {
    // simulates a tampered/legacy value reaching the check
    expect(can("ADMIN" as never, "project:read")).toBe(false);
  });

  it("viewers can read but never edit, comment, run or manage", () => {
    const allowed: Action[] = ["project:read", "file:read", "export:zip"];
    for (const a of ACTIONS) expect(can("VIEWER", a)).toBe(allowed.includes(a));
  });

  it("commenters can comment and suggest but cannot edit documents", () => {
    expect(can("COMMENTER", "comment:create")).toBe(true);
    expect(can("COMMENTER", "suggestion:create")).toBe(true);
    expect(can("COMMENTER", "file:edit")).toBe(false);
    expect(can("COMMENTER", "file:manage")).toBe(false);
    expect(can("COMMENTER", "suggestion:resolve")).toBe(false);
    expect(can("COMMENTER", "run:execute")).toBe(false);
  });

  it("editors can edit and manage files but not share, delete the project or restore", () => {
    expect(can("EDITOR", "file:edit")).toBe(true);
    expect(can("EDITOR", "file:manage")).toBe(true);
    expect(can("EDITOR", "suggestion:resolve")).toBe(true);
    expect(can("EDITOR", "share:manage")).toBe(false);
    expect(can("EDITOR", "project:delete")).toBe(false);
    expect(can("EDITOR", "project:update")).toBe(false);
    expect(can("EDITOR", "checkpoint:restore")).toBe(false);
  });

  it("owners can do everything", () => {
    for (const a of ACTIONS) expect(can("OWNER", a)).toBe(true);
  });

  it("roles are strictly nested (each role includes the one below)", () => {
    for (let i = 1; i < ROLES.length; i++) {
      const higher = ROLES[i - 1]!;
      const lower = ROLES[i]!;
      for (const a of ACTIONS) if (can(lower, a)) expect(can(higher, a)).toBe(true);
    }
  });
});
