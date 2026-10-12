import type { PrismaClient } from "@collabcode/db";
import { can, type Action, type Role } from "@collabcode/shared";
import { forbidden, notFound } from "../errors";

/** The caller's role in a project, read from the database. Never from the client. */
export async function getMemberRole(prisma: PrismaClient, projectId: string, userId: string): Promise<Role | null> {
  const m = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

/**
 * The single gate every project route goes through.
 * - Not a member -> 404 (don't reveal that the project exists).
 * - Member without the permission -> 403.
 */
export async function requireAction(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  action: Action,
): Promise<Role> {
  const role = await getMemberRole(prisma, projectId, userId);
  if (!role) throw notFound("Project not found");
  if (!can(role, action)) throw forbidden();
  return role;
}
