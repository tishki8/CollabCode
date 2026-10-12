import type { FileNodeDto } from "@collabcode/shared";

/** "utils/helpers.py" for a node id, or null if it isn't in the list. */
export function pathOfNode(nodes: readonly FileNodeDto[], id: string): string | null {
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
