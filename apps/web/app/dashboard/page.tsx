import Link from "next/link";
import { redirect } from "next/navigation";
import { LANGUAGE_INFO, type ProjectList, type ProjectSummary } from "@collabcode/shared";
import { getCurrentUser } from "@/lib/current-user";
import { serverApi } from "@/lib/api";
import { Header } from "@/components/Header";
import { CreateProjectForm } from "@/components/CreateProjectForm";

function ProjectCards({ projects, empty }: { projects: ProjectSummary[]; empty: string }) {
  if (projects.length === 0) return <p className="text-sm text-slate-600 dark:text-slate-400">{empty}</p>;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <li key={p.id}>
          <Link
            href={`/p/${p.id}`}
            className="block rounded-lg border border-slate-300 p-4 hover:border-blue-600 dark:border-slate-700"
          >
            <span className="block font-semibold">{p.name}</span>
            <span className="block text-sm text-slate-600 dark:text-slate-400">
              {LANGUAGE_INFO[p.language].label} · {p.role.toLowerCase()} · by {p.ownerName}
            </span>
            <span className="block text-xs text-slate-500">Updated {new Date(p.updatedAt).toLocaleString()}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function Dashboard() {
  const me = await getCurrentUser();
  if (!me) redirect("/");
  const { data } = await serverApi<ProjectList>("/projects");
  const projects = data ?? { mine: [], shared: [] };

  return (
    <>
      <Header userName={me.name} isGuest={me.isGuest} />
      <main id="main" className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
        {me.isGuest ? (
          <p className="rounded border border-slate-300 p-3 text-sm dark:border-slate-700">
            You are a guest, so you can open the projects shared with you but not create your own.
            <Link href="/" className="ml-1 underline">Sign in</Link> to create projects.
          </p>
        ) : (
          <>
            <section aria-labelledby="new">
              <h2 id="new" className="mb-3 text-xl font-semibold">New project</h2>
              <CreateProjectForm />
            </section>
            <section aria-labelledby="mine">
              <h2 id="mine" className="mb-3 text-xl font-semibold">My projects</h2>
              <ProjectCards projects={projects.mine} empty="You have no projects yet. Create one above." />
            </section>
          </>
        )}
        <section aria-labelledby="shared">
          <h2 id="shared" className="mb-3 text-xl font-semibold">Shared with me</h2>
          <ProjectCards projects={projects.shared} empty="Nothing has been shared with you yet." />
        </section>
      </main>
    </>
  );
}
