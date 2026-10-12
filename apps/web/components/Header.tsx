import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "@/auth";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

export function Header({ userName, isGuest = false }: { userName: string; isGuest?: boolean }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 px-6 py-3 dark:border-slate-800">
      <Link href="/dashboard" className="text-lg font-bold">
        CollabCode
      </Link>
      <div className="flex items-center gap-4 text-sm">
        <span data-testid="header-user">
          {userName}
          {isGuest && (
            <span className="ml-2 rounded border border-slate-400 px-1.5 py-0.5 text-xs" title="You joined with a link and a display name, without an account">
              guest
            </span>
          )}
        </span>
        {isGuest ? (
          <form
            action={async () => {
              "use server";
              // End the guest session on the API (deletes it) and drop the cookie.
              const jar = await cookies();
              await fetch(`${API_URL}/guest/logout`, { method: "POST", headers: { cookie: jar.toString() } });
              jar.delete("cc_guest");
              redirect("/");
            }}
          >
            <button className="rounded border border-slate-400 px-3 py-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              Leave
            </button>
          </form>
        ) : (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button className="rounded border border-slate-400 px-3 py-1 hover:bg-slate-100 dark:hover:bg-slate-800">
              Sign out
            </button>
          </form>
        )}
      </div>
    </header>
  );
}
