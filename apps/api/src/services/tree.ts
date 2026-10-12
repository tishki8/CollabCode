// Pure helpers over a project's flat list of file nodes (easy to unit test).
export interface TreeNode {
  id: string;
  parentId: string | null;
  name: string;
  type: "FILE" | "FOLDER";
}

/** "utils/helpers.py" for the node with the given id, or null if it (or an ancestor) is missing. */
export function pathOf(nodes: readonly TreeNode[], id: string): string | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur = byId.get(id);
  for (let guard = 0; cur && guard < 100; guard++) {
    parts.unshift(cur.name);
    if (cur.parentId === null) return parts.join("/");
    cur = byId.get(cur.parentId);
  }
  return null;
}

/** Find a FILE by its full path. */
export function resolveFilePath(nodes: readonly TreeNode[], path: string): TreeNode | null {
  const segments = path.split("/");
  let parentId: string | null = null;
  let found: TreeNode | undefined;
  for (const seg of segments) {
    found = nodes.find((n) => n.parentId === parentId && n.name === seg);
    if (!found) return null;
    parentId = found.id;
  }
  return found && found.type === "FILE" ? found : null;
}

/** Number of ancestors above the node (top level = 0). */
export function depthOf(nodes: readonly TreeNode[], id: string | null): number {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let depth = 0;
  let cur = id ? byId.get(id) : undefined;
  while (cur && depth < 100) {
    depth++;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return depth;
}

/** The node itself plus every descendant. */
export function subtreeIds(nodes: readonly TreeNode[], rootId: string): string[] {
  const out = [rootId];
  for (let i = 0; i < out.length; i++) {
    for (const n of nodes) if (n.parentId === out[i]) out.push(n.id);
  }
  return out;
}
