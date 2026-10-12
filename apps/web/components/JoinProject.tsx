"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { JoinResult } from "@collabcode/shared";
import { api } from "@/lib/client-api";

/** Opens a share link for a signed-in user: joins the project, then goes to it. */
export function JoinProject({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React dev mode runs effects twice; joining once is enough
    started.current = true;
    api<JoinResult>("POST", "/share-links/join", { token })
      .then((r) => router.replace(`/p/${r.projectId}`))
      .catch((e: Error) => setError(e.message));
  }, [token, router]);

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      {error ? (
        <>
          <p role="alert" className="text-red-700 dark:text-red-400">{error}</p>
          <Link href="/dashboard" className="underline">Go to my dashboard</Link>
        </>
      ) : (
        <p role="status">Joining project…</p>
      )}
    </main>
  );
}
