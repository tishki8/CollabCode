"use client";

import Editor, { loader, type OnMount } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { can, cursorCss, type CollabTokenResponse } from "@collabcode/shared";
import { fetchCollabSessionWithRetry, fileRoom, openProvider } from "@/lib/collab-client";
import { monacoLanguageFor } from "@/lib/monaco-language";

// Monaco is served from our own origin (see scripts/copy-monaco.mjs), not a CDN.
loader.config({ paths: { vs: "/monaco/vs" } });

type Status = "connecting" | "connected" | "disconnected" | "denied";

const STATUS_TEXT: Record<Status, string> = {
  connecting: "Connecting…",
  connected: "Live",
  disconnected: "Offline: your edits are kept and will merge when you reconnect",
  denied: "You no longer have access to this file",
};

interface Props {
  projectId: string;
  fileId: string;
  fileName: string;
}

/**
 * One open file. Mount it with `key={fileId}` so switching files tears everything down:
 * Y.Doc, provider (WebSocket) and the Monaco <-> Yjs binding.
 */
export function CollabEditor({ projectId, fileId, fileName }: Props) {
  const [status, setStatus] = useState<Status>("connecting");
  const [session, setSession] = useState<CollabTokenResponse | null>(null);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);
  const [remoteCount, setRemoteCount] = useState(0);
  const styleRef = useRef<HTMLStyleElement | null>(null);

  // 1. Get a token + our identity, then connect.
  useEffect(() => {
    let cancelled = false;
    let p: HocuspocusProvider | null = null;
    const ydoc = new Y.Doc();
    (async () => {
      let s: CollabTokenResponse | null;
      try {
        s = await fetchCollabSessionWithRetry(projectId, () => cancelled, () => !cancelled && setStatus("disconnected"));
      } catch {
        if (!cancelled) setStatus("denied"); // 401/403/404: the server says we may not open this
        return;
      }
      if (!s || cancelled) return;
      setSession(s);
      p = openProvider(projectId, s, fileRoom(fileId), ydoc);
      p.on("status", ({ status: st }: { status: string }) => {
        if (st === "connected") setStatus("connected");
        else if (st === "connecting") setStatus((cur) => (cur === "denied" ? cur : "connecting"));
        else setStatus((cur) => (cur === "denied" ? cur : "disconnected"));
      });
      p.on("authenticationFailed", () => setStatus("denied"));
      // Our own identity for the local awareness state; the server overwrites it with
      // the database values before broadcasting, so it cannot be spoofed.
      p.setAwarenessField("user", s.user);
      setProvider(p);
    })();
    return () => {
      cancelled = true;
      p?.destroy();
      ydoc.destroy();
      setProvider(null);
    };
  }, [projectId, fileId]);

  // 2. Bind Monaco's model to the shared Y.Text once both the editor and the provider exist.
  useEffect(() => {
    if (!editor || !provider) return;
    let binding: { destroy(): void } | null = null;
    let cancelled = false;
    // Dynamic import: y-monaco needs window.monaco, which exists once the editor has mounted.
    import("y-monaco").then(({ MonacoBinding }) => {
      const model = editor.getModel();
      if (cancelled || !model) return;
      binding = new MonacoBinding(provider.document.getText("content"), model, new Set([editor]), provider.awareness);
    });
    return () => {
      cancelled = true;
      binding?.destroy();
    };
  }, [editor, provider]);

  // 3. Style remote cursors: a coloured caret/selection plus an "initials + name" label.
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) return;
    const render = () => {
      const css: string[] = [];
      let others = 0;
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID || !state.user) return;
        others++;
        css.push(cursorCss(clientId, state.user));
      });
      setRemoteCount(others);
      if (styleRef.current) styleRef.current.textContent = css.join("\n");
    };
    awareness.on("change", render);
    render();
    return () => awareness.off("change", render);
  }, [provider]);

  const canEdit = session ? can(session.role, "file:edit") : false;

  return (
    <div className="flex h-full flex-col" data-testid="editor-pane">
      <style data-collab-cursors ref={styleRef} />
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-sm dark:border-slate-800">
        <span className="font-mono font-semibold">{fileName}</span>
        <span className="flex items-center gap-3">
          {session && !canEdit && (
            <span className="rounded border border-amber-600 px-2 py-0.5 text-xs" data-testid="readonly-badge">
              Read-only ({session.role.toLowerCase()})
            </span>
          )}
          <span className="text-xs text-slate-600 dark:text-slate-400" data-testid="remote-count">
            {remoteCount} other{remoteCount === 1 ? "" : "s"} here
          </span>
          <span
            role="status"
            data-testid="sync-status"
            data-status={status}
            className={`text-xs ${status === "connected" ? "text-green-800 dark:text-green-400" : "text-amber-800 dark:text-amber-400"}`}
          >
            {STATUS_TEXT[status]}
          </span>
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {status === "denied" ? (
          <p role="alert" className="p-6 text-sm">{STATUS_TEXT.denied}</p>
        ) : (
          <Editor
            // The model's text is owned by Yjs; start empty and let the binding fill it.
            defaultValue=""
            path={`inmemory://${fileId}/${fileName}`}
            language={monacoLanguageFor(fileName)}
            theme="vs-dark"
            onMount={(ed) => setEditor(ed)}
            options={{
              readOnly: !canEdit,
              domReadOnly: !canEdit,
              minimap: { enabled: false },
              fontSize: 14,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              ariaLabel: `Editor for ${fileName}`,
            }}
            loading={<p className="p-6 text-sm">Loading editor…</p>}
          />
        )}
      </div>
    </div>
  );
}
