"use client";

import { useEffect, useState } from "react";
import type { MeDto } from "@collabcode/shared";
import { setExpectedUser } from "@/lib/client-api";

/**
 * Signed-in state is one cookie per browser. If someone signs in as another user in a second tab of
 * the same browser, this tab's cookie silently becomes theirs: the page still says "Bob" (and its
 * WebSocket is still Bob), but REST calls would go out as the new user. This guard
 *  - tells the API who the page thinks it is (every call carries it; the server refuses a mismatch), and
 *  - checks who the cookie belongs to when the tab regains focus (and every 30 s), or when the server
 *    reports a mismatch, then shows a banner instead of letting anyone act as the wrong person.
 */
export function IdentityGuard({ userId }: { userId: string }) {
  const [now, setNow] = useState<{ name: string } | null>(null);

  useEffect(() => {
    setExpectedUser(userId);
    return () => setExpectedUser(null);
  }, [userId]);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        // No expected-user header here: we want the truth, not a refusal.
        const res = await fetch("/api/v1/me", { cache: "no-store" });
        if (stopped) return;
        if (res.status === 401) return setNow({ name: "nobody (you were signed out)" });
        if (!res.ok) return;
        const me = (await res.json()) as MeDto;
        setNow(me.id === userId ? null : { name: me.name });
      } catch {
        /* offline: nothing to conclude */
      }
    };
    const onVisible = () => !document.hidden && void check();
    const onMismatch = (e: Event) => {
      const who = (e as CustomEvent<{ name?: string } | null>).detail;
      setNow({ name: who?.name ?? "someone else" });
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("cc:identity-changed", onMismatch);
    const timer = setInterval(check, 30_000);
    return () => {
      stopped = true;
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("cc:identity-changed", onMismatch);
      clearInterval(timer);
    };
  }, [userId]);

  if (!now) return null;
  return (
    <div role="alert" data-testid="identity-banner" className="flex flex-wrap items-center gap-3 border-b border-amber-600 bg-amber-100 px-4 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-100">
      <span>
        <strong>You are now signed in as {now.name}</strong> in another tab. This tab still shows a different person, and nothing you do here will be saved as them. Reload to continue.
      </span>
      <button type="button" onClick={() => window.location.reload()} className="rounded border border-amber-800 px-2 py-0.5 hover:bg-amber-200 dark:hover:bg-amber-900" data-testid="identity-reload">
        Reload
      </button>
    </div>
  );
}
