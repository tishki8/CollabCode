import { notFound, redirect } from "next/navigation";
import type { FileNodeDto, ProjectDetail } from "@collabcode/shared";
import { getCurrentUser } from "@/lib/current-user";
import { serverApi } from "@/lib/api";
import { Header } from "@/components/Header";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ file?: string }>;
}) {
  const me = await getCurrentUser();
  if (!me) redirect("/");
  const { projectId } = await params;
  const { file } = await searchParams;

  const project = await serverApi<ProjectDetail>(`/projects/${projectId}`);
  if (!project.data) notFound(); // 404 for both "doesn't exist" and "not a member"
  const files = await serverApi<FileNodeDto[]>(`/projects/${projectId}/files`);

  return (
    <>
      <Header userName={me.name} isGuest={me.isGuest} />
      <ProjectWorkspace
        project={project.data}
        currentUserId={me.id}
        initialNodes={files.data ?? []}
        requestedFileId={typeof file === "string" ? file : null}
      />
    </>
  );
}
