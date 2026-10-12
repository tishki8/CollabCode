import type { PrismaClient } from "@collabcode/db";
import { pickColor, initialsOf, type PersonDto } from "@collabcode/shared";

/**
 * Names, colours and initials for the given user ids as they appear in a project. People who are no
 * longer members (or never were, e.g. their membership was removed later) still get a stable fallback.
 */
export async function describePeople(prisma: PrismaClient, projectId: string, userIds: string[]): Promise<PersonDto[]> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return [];
  const [users, members] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, isGuest: true } }),
    prisma.projectMember.findMany({ where: { projectId, userId: { in: ids } }, select: { userId: true, color: true, initials: true } }),
  ]);
  const memberOf = new Map(members.map((m) => [m.userId, m]));
  const known = new Map(users.map((u) => [u.id, u]));
  const used: string[] = members.map((m) => m.color);
  return ids.map((id) => {
    const u = known.get(id);
    const m = memberOf.get(id);
    const name = u?.name ?? "Unknown user";
    const color = m?.color ?? pickColor(used); // a former member: still give them a distinct colour
    if (!m) used.push(color);
    return { id, name, isGuest: u?.isGuest ?? false, color, initials: m?.initials ?? initialsOf(name) };
  });
}
