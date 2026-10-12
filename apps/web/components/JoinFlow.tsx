"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { GUEST_NAME_MAX, describeExpiry, type JoinResult, type LinkPreview } from "@collabcode/shared";
import { api, ApiRequestError } from "@/lib/client-api";

const ROLE_TEXT: Record<LinkPreview["role"], string> = {
  EDITOR: "an editor: you can edit the code",
  COMMENTER: "a commenter: you can view the code (commenting arrives in a later update)",
  VIEWER: "a viewer: you can view the code but not change it",
};

const POLL_MS = 3000;

type Phase =
  | { kind: "form" } // not signed in: ask for a display name
  | { kind: "joining" }
  | { kind: "pending" } // invite-only: waiting for the owner
  | { kind: "error"; message: string; final: boolean };

/** Plain-language message for a failed join, chosen by the API's error code. */
function messageFor(e: unknown): { message: string; final: boolean } {
  if (e instanceof ApiRequestError) {
    if (e.code === "LINK_EXPIRED") return { message: "This link has expired. Ask the project owner for a new one.", final: true };
    if (e.code === "LINK_INVALID") return { message: "This link is invalid or has been revoked.", final: true };
    if (e.code === "JOIN_DENIED") return { message: "The project owner declined your request to join.", final: true };
    if (e.code === "GUEST_LIMIT") return { message: "This project has reached its limit of guests.", final: true };
    return { message: e.message, final: false };
  }
  return { message: "Something went wrong. Please try again.", final: false };
}

/**
 * Opening a share link. Signed-in visitors (and guests who already have a cookie) join straight
 * away; everyone else gives a display name and joins as a guest. Invite-only links wait for the
 * owner's decision, re-checking every few seconds.
 */
export function JoinFlow({ token, preview, hasIdentity }: { token: string; preview: LinkPreview; hasIdentity: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(hasIdentity ? { kind: "joining" } : { kind: "form" });
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const handle = useCallback(
    (r: JoinResult) => {
      if (!alive.current) return;
      if (r.status === "joined") router.replace(`/p/${r.projectId}`);
      else setPhase({ kind: "pending" });
    },
    [router],
  );

  const fail = useCallback((e: unknown) => alive.current && setPhase({ kind: "error", ...messageFor(e) }), []);

  // Signed in (or already a guest): join automatically, once.
  const started = useRef(false);
  useEffect(() => {
    if (!hasIdentity || started.current) return;
    started.current = true; // React dev mode runs effects twice; joining once is enough
    api<JoinResult>("POST", "/share-links/join", { token }).then(handle, fail);
  }, [hasIdentity, token, handle, fail]);

  // Waiting for approval: ask again until the owner decides. The call is idempotent.
  useEffect(() => {
    if (phase.kind !== "pending") return;
    const timer = setInterval(() => {
      api<JoinResult>("POST", "/share-links/join", { token }).then(handle, fail);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [phase.kind, token, handle, fail]);

  async function submitGuest(e: React.FormEvent) {
    e.preventDefault();
    setPhase({ kind: "joining" });
    api<JoinResult>("POST", "/share-links/join-guest", { token, displayName: name }).then(handle, (err) => {
      if (!alive.current) return;
      const m = messageFor(err);
      // A bad name is the visitor's to fix: go back to the form with the message.
      setPhase(m.final ? { kind: "error", ...m } : { kind: "form" });
      if (!m.final) setFormError(m.message);
    });
  }

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 p-6">
      <header>
        <p className="text-sm text-slate-600 dark:text-slate-400">{preview.ownerName} invited you to</p>
        <h1 className="text-2xl font-bold" data-testid="join-project-name">{preview.projectName}</h1>
        <p className="mt-2 text-sm" data-testid="join-role">You will join as {ROLE_TEXT[preview.role]}.</p>
        {preview.requiresApproval && (
          <p className="mt-1 text-sm" data-testid="join-approval-note">The owner must approve your request before you get in.</p>
        )}
        {preview.expiresAt && (
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">This link {describeExpiry(preview.expiresAt)}.</p>
        )}
      </header>

      {phase.kind === "form" && (
        <form onSubmit={submitGuest} className="flex flex-col gap-3" aria-label="Join as a guest">
          <label className="flex flex-col text-sm">
            Your display name
            <input
              required
              autoFocus
              maxLength={GUEST_NAME_MAX}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sam"
              className="mt-1 rounded border border-slate-400 bg-transparent px-3 py-2"
            />
            <span className="mt-1 text-xs text-slate-600 dark:text-slate-400">
              Shown to everyone in the project, next to your cursor. No account needed.
            </span>
          </label>
          {formError && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{formError}</p>}
          <button className="rounded-md bg-blue-700 px-4 py-2 font-semibold text-white hover:bg-blue-800">
            {preview.requiresApproval ? "Ask to join as guest" : "Continue as guest"}
          </button>
          <p className="text-sm">
            Have an account?{" "}
            <Link className="underline" href={`/?callbackUrl=${encodeURIComponent(`/join/${token}`)}`}>
              Sign in instead
            </Link>
          </p>
        </form>
      )}

      {phase.kind === "joining" && <p role="status">Joining…</p>}

      {phase.kind === "pending" && (
        <div role="status" data-testid="join-pending" className="rounded border border-slate-300 p-4 dark:border-slate-700">
          <p className="font-semibold">Waiting for {preview.ownerName} to approve your request…</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Keep this page open. You will be taken to the project as soon as it is approved.
          </p>
        </div>
      )}

      {phase.kind === "error" && (
        <>
          <p role="alert" className="text-red-700 dark:text-red-400" data-testid="join-error">{phase.message}</p>
          <Link href="/dashboard" className="underline">Go to my dashboard</Link>
        </>
      )}
    </main>
  );
}
