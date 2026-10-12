import { notFound, redirect } from "next/navigation";
import { LANGUAGE_INFO, type FileNodeDto, type ProjectDetail } from "@collabcode/shared";
import { auth } from "@/auth";
import { serverApi } from "@/lib/api";
import { Header } from "@/components/Header";
import { FileTree } from "@/components/FileTree";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const { projectId } = await params;

  const project = await serverApi<ProjectDetail>(`/projects/${projectId}`);
  if (!project.data) notFound(); // 404 for both "doesn't exist" and "not a member"
  const files = await serverApi<FileNodeDto[]>(`/projects/${projectId}/files`);
  const p = project.data;

  return (
    <>
      <Header userName={session.user.name ?? "You"} />
      <main id="main" className="grid min-h-[calc(100vh-3.5rem)] grid-cols-[18rem_1fr]">
        <aside aria-label="Project files" className="border-r border-slate-200 p-4 dark:border-slate-800">
          <h1 className="text-lg font-semibold">{p.name}</h1>
          <p className="mb-4 text-sm text-slate-600 dark:text-slate-400">
            {LANGUAGE_INFO[p.language].label} · you are {p.role.toLowerCase()}
          </p>
          <FileTree projectId={p.id} role={p.role} initialNodes={files.data ?? []} />
        </aside>
        <section aria-label="Editor" className="flex items-center justify-center p-6 text-slate-600 dark:text-slate-400">
          <p>The collaborative editor arrives in Phase 2.</p>
        </section>
      </main>
    </>
  );
}
