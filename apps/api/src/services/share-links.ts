import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "@collabcode/db";
import { initialsOf, pickColor, type JoinResult, type Role } from "@collabcode/shared";
import { notFound } from "../errors";

/** 256 bits of randomness, url-safe. This is the secret in the link. */
export const newShareToken = () => randomBytes(32).toString("base64url");

/** Only this hash is stored, so a database leak does not leak working links. */
export const hashShareToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Add the user to the project with the link's role. Idempotent, and it never changes an
 * existing member's role (so the owner opening their own viewer link stays the owner).
 */
export async function joinViaShareLink(
  prisma: PrismaClient,
  token: string,
  user: { id: string; name: string },
): Promise<JoinResult> {
  const link = await prisma.shareLink.findUnique({ where: { tokenHash: hashShareToken(token) } });
  // Unknown, revoked and expired links all look the same to the caller.
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt.getTime() <= Date.now())) {
    throw notFound("This link is invalid or has been revoked");
  }

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: link.projectId, userId: user.id } },
    select: { role: true },
  });
  if (existing) return { projectId: link.projectId, role: existing.role, joined: false };

  // Colours already used in the project, so the newcomer gets a distinct one.
  const used = (await prisma.projectMember.findMany({ where: { projectId: link.projectId }, select: { color: true } })).map(
    (m) => m.color,
  );
  const role: Role = link.role;
  try {
    await prisma.projectMember.create({
      data: {
        projectId: link.projectId,
        userId: user.id,
        role,
        color: pickColor(used),
        initials: initialsOf(user.name),
        viaShareLinkId: link.id,
      },
    });
    return { projectId: link.projectId, role, joined: true };
  } catch (err) {
    // Two tabs opened the link at the same moment: the other one won, which is fine.
    if ((err as { code?: string }).code === "P2002") {
      const m = await prisma.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId: link.projectId, userId: user.id } },
        select: { role: true },
      });
      return { projectId: link.projectId, role: m.role, joined: false };
    }
    throw err;
  }
}
