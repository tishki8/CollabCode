import { describe, expect, it } from "vitest";
import { createNodeInput, createProjectInput, nodeNameSchema, updateProjectInput } from "./schemas";
import { initialsOf, pickColor, AUTHOR_PALETTE } from "./palette";

describe("nodeNameSchema", () => {
  it("accepts normal names and trims whitespace", () => {
    expect(nodeNameSchema.parse("  main.py ")).toBe("main.py");
  });
  it.each(["", "   ", "a/b", "a\\b", ".", "..", "x\u0000y", "a".repeat(101)])("rejects %j", (name) => {
    expect(nodeNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("createProjectInput", () => {
  it("rejects unknown languages and empty names", () => {
    expect(createProjectInput.safeParse({ name: "x", language: "RUBY" }).success).toBe(false);
    expect(createProjectInput.safeParse({ name: " ", language: "PYTHON" }).success).toBe(false);
    expect(createProjectInput.safeParse({ name: "ok", language: "CPP" }).success).toBe(true);
  });
});

describe("other inputs", () => {
  it("createNodeInput requires a valid type", () => {
    expect(createNodeInput.safeParse({ parentId: null, name: "a", type: "SYMLINK" }).success).toBe(false);
    expect(createNodeInput.safeParse({ parentId: null, name: "a", type: "FILE" }).success).toBe(true);
  });
  it("updateProjectInput rejects empty patches", () => {
    expect(updateProjectInput.safeParse({}).success).toBe(false);
    expect(updateProjectInput.safeParse({ entryFile: null }).success).toBe(true);
  });
});

describe("palette helpers", () => {
  it("builds initials", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("ada")).toBe("A");
    expect(initialsOf("  ")).toBe("?");
  });
  it("picks unused colours first, then wraps", () => {
    expect(pickColor([])).toBe(AUTHOR_PALETTE[0]);
    expect(pickColor([AUTHOR_PALETTE[0]])).toBe(AUTHOR_PALETTE[1]);
    expect(pickColor([...AUTHOR_PALETTE])).toBe(AUTHOR_PALETTE[0]);
  });
});
