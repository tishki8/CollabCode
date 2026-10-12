"use client";

import { useCallback, useEffect, useState } from "react";
import { SHARE_LINK_ROLES, type CreatedShareLinkDto, type ShareLinkDto } from "@collabcode/shared";
import { api } from "@/lib/client-api";

type LinkRole = (typeof SHARE_LINK_ROLES)[number];

/** Owner-only: create, copy and revoke share links. */
export function SharePanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<LinkRole>("EDITOR");
  const [links, setLinks] = useState<ShareLinkDto[]>([]);
  const [created, setCreated] = useState<{ url: string; role: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLinks(await api<ShareLinkDto[]>("GET", `/projects/${projectId}/share-links`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function create() {
    setError(null);
    setCopied(false);
    try {
      const link = await api<CreatedShareLinkDto>("POST", `/projects/${projectId}/share-links`, { role });
      // The token only exists in this response (the server keeps just a hash), so show it now.
      setCreated({ url: `${window.location.origin}/join/${link.token}`, role: link.role });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (e.g. insecure context): select the text so Ctrl+C works.
      document.getElementById("share-url")?.focus();
      (document.getElementById("share-url") as HTMLInputElement | null)?.select();
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api("DELETE", `/projects/${projectId}/share-links/${id}`);
      setCreated(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const btn = "rounded border border-slate-400 px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800";

  return (
    <section aria-label="Sharing">
      <button className={btn} aria-expanded={open} aria-controls="share-body" onClick={() => setOpen((o) => !o)}>
        Share
      </button>
      {open && (
        <div id="share-body" className="mt-3 flex flex-col gap-3" data-testid="share-body">
          <div className="flex items-end gap-2">
            <label className="flex flex-col text-xs">
              Anyone with the link can
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as LinkRole)}
                className="mt-1 rounded border border-slate-400 bg-transparent px-2 py-1 text-sm"
              >
                <option value="EDITOR" className="text-black">edit</option>
                <option value="VIEWER" className="text-black">view only</option>
              </select>
            </label>
            <button className={btn} onClick={create}>Create link</button>
          </div>

          {created && (
            <div className="flex flex-col gap-1" data-testid="created-link">
              <label className="text-xs" htmlFor="share-url">
                New {created.role.toLowerCase()} link (shown once, copy it now)
              </label>
              <input
                id="share-url"
                readOnly
                value={created.url}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded border border-slate-400 bg-transparent px-2 py-1 font-mono text-xs"
              />
              <button className={btn} onClick={copy}>{copied ? "Copied!" : "Copy link"}</button>
            </div>
          )}

          <div>
            <h3 className="mb-1 text-xs font-semibold">Active links</h3>
            {links.length === 0 ? (
              <p className="text-xs text-slate-500">No active links.</p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="link-list">
                {links.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 text-xs">
                    <span>
                      {l.role === "EDITOR" ? "Editor" : l.role === "VIEWER" ? "Viewer" : "Commenter"} link ·{" "}
                      {new Date(l.createdAt).toLocaleString()}
                    </span>
                    <button className={btn} onClick={() => revoke(l.id)} aria-label={`Revoke ${l.role.toLowerCase()} link from ${new Date(l.createdAt).toLocaleString()}`}>
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Revoking stops the link from working. People who already joined keep their access.
          </p>
          <div aria-live="polite">{error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}</div>
        </div>
      )}
    </section>
  );
}
