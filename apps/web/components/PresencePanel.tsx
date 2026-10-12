"use client";

import { useEffect, useState } from "react";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { safeColor, readableTextColor, type FileNodeDto } from "@collabcode/shared";
import { fetchCollabSessionWithRetry, openProvider, presenceRoom } from "@/lib/collab-client";
import { pathOfNode } from "@/lib/tree-path";

interface Person {
  id: string;
  name: string;
  initials: string;
  color: string;
  fileId: string | null;
  isYou: boolean;
  isGuest: boolean;
}

/**
 * Who is online in this project and which file each person is viewing. Uses a separate
 * awareness-only room (`presence:<projectId>`) so it works across files, not just the open one.
 */
export function PresencePanel({
  projectId,
  currentUserId,
  activeFileId,
  nodes,
}: {
  projectId: string;
  currentUserId: string;
  activeFileId: string | null;
  nodes: FileNodeDto[];
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  useEffect(() => {
    let cancelled = false;
    let p: HocuspocusProvider | null = null;
    const ydoc = new Y.Doc();
    fetchCollabSessionWithRetry(projectId, () => cancelled)
      .then((s) => {
        if (!s || cancelled) return;
        p = openProvider(projectId, s, presenceRoom(projectId), ydoc);
        p.setAwarenessField("user", s.user);
        const update = () => {
          // One entry per person even if they have several tabs open.
          const byUser = new Map<string, Person>();
          p!.awareness!.getStates().forEach((st) => {
            if (!st.user?.id) return;
            byUser.set(st.user.id, {
              id: String(st.user.id),
              name: String(st.user.name ?? "Unknown"),
              initials: String(st.user.initials ?? "?").slice(0, 3),
              color: safeColor(st.user.color),
              fileId: typeof st.fileId === "string" ? st.fileId : null,
              isYou: st.user.id === currentUserId,
              isGuest: st.user.isGuest === true,
            });
          });
          setPeople([...byUser.values()].sort((a, b) => Number(b.isYou) - Number(a.isYou) || a.name.localeCompare(b.name)));
        };
        p.awareness!.on("change", update);
        setProvider(p);
        update();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      p?.destroy();
      ydoc.destroy();
      setProvider(null);
    };
  }, [projectId, currentUserId]);

  // Tell everyone which file we are looking at.
  useEffect(() => {
    provider?.setAwarenessField("fileId", activeFileId ?? undefined);
  }, [provider, activeFileId]);

  return (
    <section aria-labelledby="presence-heading" data-testid="presence-panel">
      <h2 id="presence-heading" className="mb-2 text-sm font-semibold">
        Online now ({people.length})
      </h2>
      {people.length === 0 ? (
        <p className="text-xs text-slate-500">Connecting…</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-2 text-sm" data-testid="presence-person">
              {/* Colour + initials + full name: identity never relies on colour alone. */}
              <span
                aria-hidden="true"
                className="inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-bold"
                style={{ backgroundColor: p.color, color: readableTextColor(p.color) }}
              >
                {p.initials}
              </span>
              <span className="flex flex-col leading-tight">
                <span>
                  {p.name}
                  {p.isGuest && (
                    <span className="ml-1 rounded border border-slate-400 px-1 text-xs" data-testid="guest-tag">guest</span>
                  )}
                  {p.isYou && " (you)"}
                </span>
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  {p.fileId ? (pathOfNode(nodes, p.fileId) ?? "another file") : "not viewing a file"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
