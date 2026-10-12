import { notFound, redirect } from "next/navigation";
import type { FileNodeDto, ProjectDetail } from "@collabcode/shared";
import { auth } from "@/auth";
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
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const { projectId } = await params;
  const { file } = await searchParams;

  const project = await serverApi<ProjectDetail>(`/projects/${projectId}`);
  if (!project.data) notFound(); // 404 for both "doesn't exist" and "not a member"
  const files = await serverApi<FileNodeDto[]>(`/projects/${projectId}/files`);

  return (
    <>
      <Header userName={session.user.name ?? "You"} />
      <ProjectWorkspace
        project={project.data}
        currentUserId={session.user.id}
        initialNodes={files.data ?? []}
        requestedFileId={typeof file === "string" ? file : null}
      />
    </>
  );
}
