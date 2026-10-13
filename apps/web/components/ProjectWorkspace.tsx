"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { LANGUAGE_INFO, can, type FileNodeDto, type ProjectDetail } from "@collabcode/shared";
import { FileTree } from "./FileTree";
import { PresencePanel } from "./PresencePanel";
import { SharePanel } from "./SharePanel";
import { HistoryPanel } from "./HistoryPanel";
import { ContributionsPanel } from "./ContributionsPanel";
import { CheckpointsPanel } from "./CheckpointsPanel";
import { ReplayPanel } from "./ReplayPanel";
import { IdentityGuard } from "./IdentityGuard";
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

type Tab = "editor" | "history" | "replay" | "checkpoints" | "contributions";
const TABS: { id: Tab; label: string }[] = [
  { id: "editor", label: "Editor" },
  { id: "history", label: "History" },
  { id: "replay", label: "Replay" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "contributions", label: "Contributions" },
];

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
  const [tab, setTab] = useState<Tab>("editor");
  const [treeVersion, setTreeVersion] = useState(0);
  // Panels are created the first time they are opened, then kept (the editor must stay connected).
  const [opened, setOpened] = useState<Set<Tab>>(new Set(["editor"]));
  const show = (t: Tab) => {
    setTab(t);
    setOpened((o) => new Set(o).add(t));
  };

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
    <>
    <IdentityGuard userId={currentUserId} />
    <main id="main" className="grid h-[calc(100vh-3.5rem)] grid-cols-[19rem_1fr]">
      <aside aria-label="Project sidebar" className="flex flex-col gap-6 overflow-y-auto border-r border-slate-200 p-4 dark:border-slate-800">
        <div className="flex flex-col gap-3">
          <div>
            <h1 className="text-lg font-semibold">{project.name}</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {LANGUAGE_INFO[project.language].label} · you are {project.role.toLowerCase()}
            </p>
          </div>
          {/* Sharing is the main way to get collaborators in, so it lives at the top, not the bottom. */}
          {can(project.role, "share:manage") ? (
            <SharePanel projectId={project.id} />
          ) : (
            <p className="text-xs text-slate-600 dark:text-slate-400">Only the project owner can create share links.</p>
          )}
        </div>
        <FileTree
          projectId={project.id}
          role={project.role}
          initialNodes={initialNodes}
          activeFileId={activeFileId}
          onOpenFile={openFile}
          onNodesChange={setNodes}
          refreshKey={treeVersion}
        />
        <PresencePanel projectId={project.id} currentUserId={currentUserId} activeFileId={active?.id ?? null} nodes={nodes} />
      </aside>
      <section aria-label="Workspace" className="flex min-h-0 min-w-0 flex-col">
        <div role="tablist" aria-label="Views" className="flex gap-1 border-b border-slate-200 px-3 pt-2 dark:border-slate-800">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => show(t.id)}
              data-testid={`tab-${t.id}`}
              className={`rounded-t px-3 py-1.5 text-sm ${
                tab === t.id ? "border border-b-0 border-slate-300 bg-white font-semibold dark:border-slate-700 dark:bg-slate-950" : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-900"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div id="panel-editor" role="tabpanel" aria-labelledby="tab-editor" hidden={tab !== "editor"} className="min-h-0 flex-1">
          {active ? (
            <CollabEditor key={active.id} projectId={project.id} fileId={active.id} fileName={active.name} />
          ) : (
            <p className="flex h-full items-center justify-center p-6 text-slate-600 dark:text-slate-400">Select a file to start editing.</p>
          )}
        </div>

        {opened.has("history") && (
          <div id="panel-history" role="tabpanel" aria-labelledby="tab-history" hidden={tab !== "history"} className="min-h-0 flex-1">
            {active ? (
              <HistoryPanel key={active.id} projectId={project.id} fileId={active.id} fileName={active.name} />
            ) : (
              <p className="p-6 text-slate-600 dark:text-slate-400">Select a file to see its history.</p>
            )}
          </div>
        )}

        {tab === "replay" && ( // mounted only while shown, so it always loads the latest history
          <div id="panel-replay" role="tabpanel" aria-labelledby="tab-replay" className="min-h-0 flex-1">
            {active ? (
              <ReplayPanel key={active.id} fileId={active.id} fileName={active.name} />
            ) : (
              <p className="p-6 text-slate-600 dark:text-slate-400">Select a file to replay it.</p>
            )}
          </div>
        )}

        {tab === "checkpoints" && (
          <div id="panel-checkpoints" role="tabpanel" aria-labelledby="tab-checkpoints" className="min-h-0 flex-1">
            <CheckpointsPanel
              projectId={project.id}
              role={project.role}
              activeFile={active ? { id: active.id, name: active.name } : null}
              onTreeChanged={() => setTreeVersion((v) => v + 1)}
            />
          </div>
        )}

        {opened.has("contributions") && (
          <div id="panel-contributions" role="tabpanel" aria-labelledby="tab-contributions" hidden={tab !== "contributions"} className="min-h-0 flex-1">
            <ContributionsPanel projectId={project.id} />
          </div>
        )}
      </section>
    </main>
    </>
  );
}
