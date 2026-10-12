import Link from "next/link";
import { signOut } from "@/auth";

export function Header({ userName }: { userName: string }) {
  return (
    <header className="flex items-center justify-between border-b border-slate-200 px-6 py-3 dark:border-slate-800">
      <Link href="/dashboard" className="text-lg font-bold">
        CollabCode
      </Link>
      <div className="flex items-center gap-4 text-sm">
        <span>{userName}</span>
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
      </div>
    </header>
  );
}
