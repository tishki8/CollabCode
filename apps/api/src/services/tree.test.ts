import { describe, expect, it } from "vitest";
import { depthOf, pathOf, resolveFilePath, subtreeIds, type TreeNode } from "./tree";

const nodes: TreeNode[] = [
  { id: "src", parentId: null, name: "src", type: "FOLDER" },
  { id: "util", parentId: "src", name: "util", type: "FOLDER" },
  { id: "a", parentId: "util", name: "a.py", type: "FILE" },
  { id: "main", parentId: null, name: "main.py", type: "FILE" },
];

describe("tree helpers", () => {
  it("builds full paths", () => {
    expect(pathOf(nodes, "a")).toBe("src/util/a.py");
    expect(pathOf(nodes, "main")).toBe("main.py");
    expect(pathOf(nodes, "nope")).toBeNull();
  });
  it("resolves only files by path", () => {
    expect(resolveFilePath(nodes, "src/util/a.py")?.id).toBe("a");
    expect(resolveFilePath(nodes, "src/util")).toBeNull(); // a folder is not a valid entry file
    expect(resolveFilePath(nodes, "src/missing.py")).toBeNull();
  });
  it("computes depth", () => {
    expect(depthOf(nodes, null)).toBe(0);
    expect(depthOf(nodes, "src")).toBe(1);
    expect(depthOf(nodes, "util")).toBe(2);
  });
  it("collects a subtree", () => {
    expect(subtreeIds(nodes, "src").sort()).toEqual(["a", "src", "util"]);
    expect(subtreeIds(nodes, "main")).toEqual(["main"]);
  });
});
