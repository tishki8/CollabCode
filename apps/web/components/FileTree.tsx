"use client";

import { useEffect, useState } from "react";
import { can, type FileNodeDto, type Role } from "@collabcode/shared";
import { api } from "@/lib/client-api";

type Pending =
  | { kind: "create"; type: "FILE" | "FOLDER"; parentId: string | null }
  | { kind: "rename"; id: string; current: string }
  | null;

// Folders first, then files, each alphabetical.
const sortNodes = (a: FileNodeDto, b: FileNodeDto) =>
  a.type === b.type ? a.name.localeCompare(b.name) : a.type === "FOLDER" ? -1 : 1;

export function FileTree({
  projectId,
  role,
  initialNodes,
  activeFileId = null,
  onOpenFile,
  onNodesChange,
}: {
  projectId: string;
  role: Role;
  initialNodes: FileNodeDto[];
  /** The file currently open in the editor (highlighted). */
  activeFileId?: string | null;
  onOpenFile?: (node: FileNodeDto) => void;
  /** Called whenever the tree changes, so the page can react (e.g. a deleted file closes). */
  onNodesChange?: (nodes: FileNodeDto[]) => void;
}) {
  const [nodes, setNodes] = useState(initialNodes);
  useEffect(() => onNodesChange?.(nodes), [nodes, onNodesChange]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // UI convenience only: the API enforces the real permission on every call.
  const canManage = can(role, "file:manage");
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  async function refresh() {
    setNodes(await api<FileNodeDto[]>("GET", `/projects/${projectId}/files`));
  }

  // New items go inside the selected folder, beside the selected file, or at the top level.
  function startCreate(type: "FILE" | "FOLDER") {
    const parentId = selected ? (selected.type === "FOLDER" ? selected.id : selected.parentId) : null;
    setPending({ kind: "create", type, parentId });
    setName("");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    try {
      if (pending.kind === "create") {
        const node = await api<FileNodeDto>("POST", `/projects/${projectId}/files`, {
          parentId: pending.parentId,
          name,
          type: pending.type,
        });
        if (pending.parentId) setCollapsed((c) => new Set([...c].filter((id) => id !== pending.parentId)));
        setSelectedId(node.id);
      } else {
        await api("PATCH", `/files/${pending.id}`, { name });
      }
      await refresh();
      setPending(null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(node: FileNodeDto) {
    const what = node.type === "FOLDER" ? `the folder "${node.name}" and everything in it` : `"${node.name}"`;
    if (!window.confirm(`Delete ${what}?`)) return;
    try {
      await api("DELETE", `/files/${node.id}`);
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function renderLevel(parentId: string | null) {
    const level = nodes.filter((n) => n.parentId === parentId).sort(sortNodes);
    if (level.length === 0) return null;
    return (
      <ul className={parentId ? "ml-4 border-l border-slate-300 pl-2 dark:border-slate-700" : ""}>
        {level.map((n) => {
          const isOpen = n.type === "FOLDER" && !collapsed.has(n.id);
          const isSelected = n.id === selectedId;
          return (
            <li key={n.id}>
              <button
                type="button"
                aria-current={n.id === activeFileId ? "page" : isSelected ? "true" : undefined}
                aria-expanded={n.type === "FOLDER" ? isOpen : undefined}
                onClick={() => {
                  setSelectedId(n.id);
                  if (n.type === "FILE") onOpenFile?.(n);
                  if (n.type === "FOLDER") {
                    setCollapsed((c) => {
                      const next = new Set(c);
                      if (next.has(n.id)) next.delete(n.id);
                      else next.add(n.id);
                      return next;
                    });
                  }
                }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${
                  n.id === activeFileId ? "bg-blue-200 font-semibold dark:bg-blue-900" : isSelected ? "bg-blue-100 dark:bg-blue-950" : ""
                }`}
              >
                <span aria-hidden="true">{n.type === "FOLDER" ? (isOpen ? "▾" : "▸") : "·"}</span>
                <span className="sr-only">{n.type === "FOLDER" ? "Folder" : "File"}</span>
                {n.name}
              </button>
              {isOpen && renderLevel(n.id)}
            </li>
          );
        })}
      </ul>
    );
  }

  const btn = "rounded border border-slate-400 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800";

  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <div className="flex flex-wrap gap-2" role="toolbar" aria-label="File actions">
          <button className={btn} onClick={() => startCreate("FILE")}>New file</button>
          <button className={btn} onClick={() => startCreate("FOLDER")}>New folder</button>
          <button
            className={btn}
            disabled={!selected}
            onClick={() => selected && (setPending({ kind: "rename", id: selected.id, current: selected.name }), setName(selected.name), setError(null))}
          >
            Rename
          </button>
          <button className={btn} disabled={!selected} onClick={() => selected && remove(selected)}>
            Delete
          </button>
        </div>
      ) : (
        <p className="text-xs text-slate-600 dark:text-slate-400">Your role cannot change the file tree.</p>
      )}

      {pending && (
        <form onSubmit={submit} className="flex flex-col gap-2" aria-label={pending.kind === "create" ? "Create" : "Rename"}>
          <label className="text-sm">
            {pending.kind === "create" ? `New ${pending.type === "FILE" ? "file" : "folder"} name` : "New name"}
            <input
              autoFocus
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setPending(null)}
              className="mt-1 w-full rounded border border-slate-400 bg-transparent px-2 py-1"
            />
          </label>
          <div className="flex gap-2">
            <button className={btn}>Save</button>
            <button type="button" className={btn} onClick={() => setPending(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div aria-live="polite">
        {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      </div>

      <nav aria-label="File tree">
        {nodes.length === 0 ? <p className="text-sm text-slate-500">No files yet.</p> : renderLevel(null)}
      </nav>
    </div>
  );
}
