import { redirect } from "next/navigation";
import { DEV_SESSION_TOKENS } from "@collabcode/shared";
import { auth, enabledProviders, signIn } from "@/auth";

export default async function Home() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");
  const devLogin = process.env.DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-bold">CollabCode</h1>
      <p className="text-slate-600 dark:text-slate-300">
        Edit code together in real time and always know who wrote what.
      </p>

      <div className="flex flex-col gap-3">
        {enabledProviders.map((p) => (
          <form
            key={p.id}
            action={async () => {
              "use server";
              await signIn(p.id, { redirectTo: "/dashboard" });
            }}
          >
            <button className="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200">
              Continue with {p.name}
            </button>
          </form>
        ))}
        {enabledProviders.length === 0 && (
          <p role="status" className="rounded-md border border-amber-600 p-3 text-sm">
            No OAuth provider is configured. Set AUTH_GOOGLE_ID / AUTH_GITHUB_ID in your .env (see README).
          </p>
        )}
      </div>

      {devLogin && (
        <section aria-labelledby="dev-login" className="rounded-md border border-dashed border-slate-400 p-4">
          <h2 id="dev-login" className="mb-2 text-sm font-semibold">
            Development login (seeded demo users)
          </h2>
          <ul className="flex gap-4 text-sm underline">
            {Object.keys(DEV_SESSION_TOKENS).map((u) => (
              <li key={u}>
                <a href={`/api/dev-login?user=${u}`}>Sign in as {u}</a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
