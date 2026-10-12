"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LINK_EXPIRY_CHOICES,
  describeExpiry,
  isExpired,
  type CreatedShareLinkDto,
  type JoinRequestDto,
  type LinkExpiryChoice,
  type ShareLinkDto,
  type ShareLinkRole,
} from "@collabcode/shared";
import { api } from "@/lib/client-api";

const ROLE_LABEL: Record<ShareLinkRole, string> = { EDITOR: "Editor", COMMENTER: "Commenter", VIEWER: "Viewer" };
const EXPIRY_LABEL: Record<LinkExpiryChoice, string> = { "1h": "1 hour", "1d": "1 day", "7d": "7 days", never: "never" };
const POLL_MS = 5000;

/** Owner-only: create, copy and revoke share links, and decide join requests. */
export function SharePanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<ShareLinkRole>("EDITOR");
  const [expiresIn, setExpiresIn] = useState<LinkExpiryChoice>("7d");
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [links, setLinks] = useState<ShareLinkDto[]>([]);
  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  const [created, setCreated] = useState<{ url: string; link: ShareLinkDto } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLinks = useCallback(async () => {
    try {
      setLinks(await api<ShareLinkDto[]>("GET", `/projects/${projectId}/share-links`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(await api<JoinRequestDto[]>("GET", `/projects/${projectId}/join-requests`));
    } catch {
      /* transient: the next poll will retry */
    }
  }, [projectId]);

  // Pending requests are checked in the background so the owner is told even when the panel is closed.
  useEffect(() => {
    void loadRequests();
    const timer = setInterval(loadRequests, POLL_MS);
    return () => clearInterval(timer);
  }, [loadRequests]);

  useEffect(() => {
    if (open) void loadLinks();
  }, [open, loadLinks]);

  async function create() {
    setError(null);
    setCopied(false);
    try {
      const link = await api<CreatedShareLinkDto>("POST", `/projects/${projectId}/share-links`, { role, expiresIn, requiresApproval });
      // The token only exists in this response (the server keeps just a hash), so show it now.
      setCreated({ url: `${window.location.origin}/join/${link.token}`, link });
      await loadLinks();
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
      (document.getElementById("share-url") as HTMLInputElement | null)?.select();
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await api("DELETE", `/projects/${projectId}/share-links/${id}`);
      setCreated(null);
      await Promise.all([loadLinks(), loadRequests()]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function decide(id: string, action: "approve" | "reject") {
    setError(null);
    try {
      await api("POST", `/projects/${projectId}/join-requests/${id}/${action}`);
    } catch (e) {
      setError((e as Error).message); // e.g. already decided in another tab
    }
    await loadRequests();
  }

  const btn = "rounded border border-slate-400 px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800";
  const field = "mt-1 rounded border border-slate-400 bg-transparent px-2 py-1 text-sm";

  return (
    <section aria-label="Sharing">
      <button
        className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800"
        aria-expanded={open}
        aria-controls="share-body"
        onClick={() => setOpen((o) => !o)}
      >
        Share project
        {requests.length > 0 && (
          <span
            data-testid="pending-badge"
            className="rounded-full bg-amber-300 px-2 py-0.5 text-xs font-bold text-black"
            aria-label={`${requests.length} waiting for approval`}
          >
            {requests.length} waiting
          </span>
        )}
      </button>

      {open && (
        <div id="share-body" className="mt-3 flex flex-col gap-4" data-testid="share-body">
          {requests.length > 0 && (
            <div data-testid="join-requests">
              <h3 className="mb-1 text-xs font-semibold">Waiting for your approval</h3>
              <ul className="flex flex-col gap-2">
                {requests.map((r) => (
                  <li key={r.id} className="rounded border border-amber-500 p-2 text-xs" data-testid="join-request">
                    <p>
                      <strong>{r.requester.name}</strong>
                      {r.requester.isGuest && <span className="ml-1 rounded border border-slate-400 px-1">guest</span>} wants to
                      join as {r.role.toLowerCase()}
                    </p>
                    <div className="mt-1 flex gap-2">
                      <button className={btn} onClick={() => decide(r.id, "approve")} aria-label={`Approve ${r.requester.name}`}>
                        Approve
                      </button>
                      <button className={btn} onClick={() => decide(r.id, "reject")} aria-label={`Reject ${r.requester.name}`}>
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form
            className="flex flex-col gap-2"
            aria-label="New share link"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="flex flex-col text-xs">
              Anyone with the link can
              <select value={role} onChange={(e) => setRole(e.target.value as ShareLinkRole)} className={field}>
                <option value="EDITOR" className="text-black">edit</option>
                <option value="COMMENTER" className="text-black">comment</option>
                <option value="VIEWER" className="text-black">view only</option>
              </select>
            </label>
            <label className="flex flex-col text-xs">
              Link expires
              <select value={expiresIn} onChange={(e) => setExpiresIn(e.target.value as LinkExpiryChoice)} className={field}>
                {LINK_EXPIRY_CHOICES.map((c) => (
                  <option key={c} value={c} className="text-black">{EXPIRY_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={requiresApproval} onChange={(e) => setRequiresApproval(e.target.checked)} />
              Require my approval to join
            </label>
            <button className={btn}>Create link</button>
          </form>

          {created && (
            <div className="flex flex-col gap-1" data-testid="created-link">
              <label className="text-xs" htmlFor="share-url">
                New {created.link.role.toLowerCase()} link, {describeExpiry(created.link.expiresAt)}
                {created.link.requiresApproval ? ", needs your approval" : ""} (shown once, copy it now)
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
              <ul className="flex flex-col gap-2" data-testid="link-list">
                {links.map((l) => {
                  const expired = isExpired(l.expiresAt);
                  const when = new Date(l.createdAt).toLocaleString();
                  return (
                    <li key={l.id} className="flex items-start justify-between gap-2 text-xs" data-testid="link-row">
                      <span>
                        <strong>{ROLE_LABEL[l.role]}</strong> link
                        {l.requiresApproval && " · needs approval"}
                        <br />
                        <span className={expired ? "font-semibold text-red-700 dark:text-red-400" : "text-slate-600 dark:text-slate-400"}>
                          {describeExpiry(l.expiresAt)}
                        </span>{" "}
                        · created {when}
                      </span>
                      <button className={btn} onClick={() => revoke(l.id)} aria-label={`Revoke ${l.role.toLowerCase()} link from ${when}`}>
                        Revoke
                      </button>
                    </li>
                  );
                })}
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
