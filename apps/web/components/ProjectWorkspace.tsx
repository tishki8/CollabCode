"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { LANGUAGE_INFO, can, type FileNodeDto, type ProjectDetail } from "@collabcode/shared";
import { FileTree } from "./FileTree";
import { PresencePanel } from "./PresencePanel";
import { SharePanel } from "./SharePanel";
import { pathOfNode } from "@/lib/tree-path";

// Monaco only works in the browser.
const CollabEditor = dynamic(() => import("./CollabEditor").then((m) => m.CollabEditor), {
  ssr: false,
  loading: () => <p className="p-6 text-sm">Loading editor…</p>,
});

/** Pick the file to open first: ?file=<id>, else the project's entry file, else the first file. */
function initialFileId(project: ProjectDetail, nodes: FileNodeDto[], wanted: string | null): string | null {
  const files = nodes.filter((n) => n.type === "FILE");
  const entry = project.entryFile ?? LANGUAGE_INFO[project.language].defaultEntryFile;
  return (
    files.find((f) => f.id === wanted)?.id ??
    files.find((f) => pathOfNode(nodes, f.id) === entry)?.id ??
    files[0]?.id ??
    null
  );
}

export function ProjectWorkspace({
  project,
  currentUserId,
  initialNodes,
  requestedFileId,
}: {
  project: ProjectDetail;
  currentUserId: string;
  initialNodes: FileNodeDto[];
  /** From the `?file=` URL parameter. */
  requestedFileId: string | null;
}) {
  const [nodes, setNodes] = useState(initialNodes);
  const [activeFileId, setActiveFileId] = useState<string | null>(() => initialFileId(project, initialNodes, requestedFileId));
  const active = nodes.find((n) => n.id === activeFileId && n.type === "FILE") ?? null;

  const openFile = useCallback((n: FileNodeDto) => {
    setActiveFileId(n.id);
    const url = new URL(window.location.href);
    url.searchParams.set("file", n.id);
    window.history.replaceState(null, "", url);
  }, []);

  // A file that was deleted from the tree can't stay open.
  useEffect(() => {
    if (activeFileId && !nodes.some((n) => n.id === activeFileId)) setActiveFileId(null);
  }, [nodes, activeFileId]);

  return (
    <main id="main" className="grid h-[calc(100vh-3.5rem)] grid-cols-[19rem_1fr]">
      <aside aria-label="Project sidebar" className="flex flex-col gap-6 overflow-y-auto border-r border-slate-200 p-4 dark:border-slate-800">
        <div>
          <h1 className="text-lg font-semibold">{project.name}</h1>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {LANGUAGE_INFO[project.language].label} · you are {project.role.toLowerCase()}
          </p>
        </div>
        <FileTree
          projectId={project.id}
          role={project.role}
          initialNodes={initialNodes}
          activeFileId={activeFileId}
          onOpenFile={openFile}
          onNodesChange={setNodes}
        />
        <PresencePanel projectId={project.id} currentUserId={currentUserId} activeFileId={active?.id ?? null} nodes={nodes} />
        {can(project.role, "share:manage") && <SharePanel projectId={project.id} />}
      </aside>
      <section aria-label="Editor" className="min-w-0">
        {active ? (
          <CollabEditor key={active.id} projectId={project.id} fileId={active.id} fileName={active.name} />
        ) : (
          <p className="flex h-full items-center justify-center p-6 text-slate-600 dark:text-slate-400">
            Select a file to start editing.
          </p>
        )}
      </section>
    </main>
  );
}
