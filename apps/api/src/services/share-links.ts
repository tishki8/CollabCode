import type { Prisma, PrismaClient } from "@collabcode/db";
import {
  MAX_GUESTS_PER_PROJECT,
  initialsOf,
  isExpired,
  pickColor,
  type JoinResult,
  type LinkPreview,
  type Role,
} from "@collabcode/shared";
import { conflict, forbidden, gone, notFound, HttpError } from "../errors";
import { hashToken, newSecretToken } from "./tokens";

/** Either the normal client or the one inside a transaction. */
type Db = PrismaClient | Prisma.TransactionClient;

export const newShareToken = newSecretToken;
export const hashShareToken = hashToken;

/** A leaked invite-only link must not let strangers pile up unlimited pending requests. */
export const MAX_PENDING_PER_LINK = 50;

const GUEST_SESSION_DAYS = 30;

type LinkRow = Prisma.ShareLinkGetPayload<object>;

/**
 * The one place that decides whether a link can be used right now.
 * - unknown or revoked  -> 404 (indistinguishable, so the owner's revoke reveals nothing)
 * - expired             -> 410 with a clear, specific message
 * Expiry is judged by the server's clock only.
 */
export async function loadUsableLink(db: Db, token: string): Promise<LinkRow> {
  const link = await db.shareLink.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!link || link.revokedAt) throw notFound("This link is invalid or has been revoked", "LINK_INVALID");
  if (isExpired(link.expiresAt)) throw gone("This link has expired. Ask the project owner for a new one.", "LINK_EXPIRED");
  return link;
}

export async function previewShareLink(db: Db, token: string): Promise<LinkPreview> {
  const link = await loadUsableLink(db, token);
  const project = await db.project.findUniqueOrThrow({ where: { id: link.projectId }, select: { name: true, ownerId: true } });
  const owner = await db.user.findUnique({ where: { id: project.ownerId }, select: { name: true } });
  return {
    projectName: project.name,
    ownerName: owner?.name ?? "the owner",
    role: link.role,
    requiresApproval: link.requiresApproval,
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}

/** Number of guests who are members of the project (they are capped per project). */
async function guestCount(db: Db, projectId: string) {
  return db.projectMember.count({ where: { projectId, user: { isGuest: true } } });
}

/**
 * Add a member with a distinct colour. Idempotent: if two requests race, the loser reads the
 * winner's row. Never changes an existing member's role.
 */
export async function addMember(
  db: Db,
  args: { projectId: string; user: { id: string; name: string; isGuest: boolean }; role: Role; linkId: string },
): Promise<{ role: Role; joined: boolean }> {
  const { projectId, user, role, linkId } = args;
  const existing = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { role: true },
  });
  if (existing) return { role: existing.role, joined: false };

  if (user.isGuest && (await guestCount(db, projectId)) >= MAX_GUESTS_PER_PROJECT) {
    throw forbidden("This project has reached its limit of guests.", "GUEST_LIMIT");
  }
  const used = (await db.projectMember.findMany({ where: { projectId }, select: { color: true } })).map((m) => m.color);
  try {
    await db.projectMember.create({
      data: {
        projectId,
        userId: user.id,
        role,
        color: pickColor(used),
        initials: initialsOf(user.name),
        viaShareLinkId: linkId,
      },
    });
    return { role, joined: true };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      // Two tabs opened the link at the same moment: the other one won, which is fine.
      const m = await db.projectMember.findUniqueOrThrow({
        where: { projectId_userId: { projectId, userId: user.id } },
        select: { role: true },
      });
      return { role: m.role, joined: false };
    }
    throw err;
  }
}

/**
 * Open a link as `user` (an account holder or a guest). Idempotent, so a waiting visitor can
 * simply call it again to learn whether the owner has decided.
 * - already a member: nothing changes (no upgrade, no downgrade)
 * - open link: becomes a member with the link's role
 * - invite-only link: records ONE pending request; membership only after the owner approves
 */
export async function joinViaLink(
  prisma: PrismaClient,
  link: LinkRow,
  user: { id: string; name: string; isGuest: boolean },
): Promise<JoinResult> {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: link.projectId, userId: user.id } },
    select: { role: true },
  });
  if (member) return { status: "joined", projectId: link.projectId, role: member.role, joined: false };

  if (!link.requiresApproval) {
    const r = await addMember(prisma, { projectId: link.projectId, user, role: link.role, linkId: link.id });
    return { status: "joined", projectId: link.projectId, ...r };
  }

  const request = await prisma.joinRequest.findUnique({
    where: { shareLinkId_userId: { shareLinkId: link.id, userId: user.id } },
  });
  if (!request) {
    const pending = await prisma.joinRequest.count({ where: { shareLinkId: link.id, status: "PENDING" } });
    if (pending >= MAX_PENDING_PER_LINK) {
      throw new HttpError(429, "Too many people are waiting to join. Please try again later.");
    }
    await prisma.joinRequest.upsert({
      where: { shareLinkId_userId: { shareLinkId: link.id, userId: user.id } },
      update: {},
      create: { shareLinkId: link.id, userId: user.id },
    });
    return { status: "pending" };
  }
  if (request.status === "PENDING") return { status: "pending" };
  if (request.status === "DENIED") throw forbidden("The project owner declined your request to join.", "JOIN_DENIED");
  // APPROVED but not a member (e.g. membership was later removed): re-add with the link's role.
  const r = await addMember(prisma, { projectId: link.projectId, user, role: link.role, linkId: link.id });
  return { status: "joined", projectId: link.projectId, ...r };
}

/** A guest: a user row with a display name and no account, plus a cookie session. */
export async function createGuest(prisma: PrismaClient, displayName: string) {
  const token = newSecretToken();
  const expires = new Date(Date.now() + GUEST_SESSION_DAYS * 864e5);
  const user = await prisma.user.create({
    data: {
      name: displayName,
      isGuest: true,
      guestSessions: { create: { tokenHash: hashToken(token), expiresAt: expires } },
    },
    select: { id: true, name: true, isGuest: true },
  });
  return { user, token, expires };
}

/** Rejects early (before creating a guest row) when the project already has its maximum of guests. */
export async function assertGuestRoom(prisma: PrismaClient, link: LinkRow) {
  if (link.requiresApproval) return; // the cap is enforced when the owner approves
  if ((await guestCount(prisma, link.projectId)) >= MAX_GUESTS_PER_PROJECT) {
    throw forbidden("This project has reached its limit of guests.", "GUEST_LIMIT");
  }
}

// ---------- owner decisions ----------

export async function approveJoinRequest(prisma: PrismaClient, projectId: string, requestId: string, deciderId: string) {
  await prisma.$transaction(async (tx) => {
    const request = await tx.joinRequest.findUnique({
      where: { id: requestId },
      include: { shareLink: true },
    });
    // Scoped by project so one owner can't decide another project's requests by guessing ids.
    if (!request || request.shareLink.projectId !== projectId) throw notFound("Request not found");
    if (request.shareLink.revokedAt) throw conflict("This link was revoked, so the request can no longer be approved.");

    // Guarded update: if two owner tabs click at once, only one wins.
    const { count } = await tx.joinRequest.updateMany({
      where: { id: requestId, status: "PENDING" },
      data: { status: "APPROVED", decidedById: deciderId, decidedAt: new Date() },
    });
    if (count === 0) throw conflict("This request was already decided.");

    const user = await tx.user.findUniqueOrThrow({
      where: { id: request.userId },
      select: { id: true, name: true, isGuest: true },
    });
    // The member gets the LINK's role, not anything the requester sent.
    await addMember(tx, { projectId, user, role: request.shareLink.role, linkId: request.shareLinkId });
  });
}

export async function rejectJoinRequest(prisma: PrismaClient, projectId: string, requestId: string, deciderId: string) {
  const request = await prisma.joinRequest.findUnique({ where: { id: requestId }, include: { shareLink: true } });
  if (!request || request.shareLink.projectId !== projectId) throw notFound("Request not found");
  const { count } = await prisma.joinRequest.updateMany({
    where: { id: requestId, status: "PENDING" },
    data: { status: "DENIED", decidedById: deciderId, decidedAt: new Date() },
  });
  if (count === 0) throw conflict("This request was already decided.");
}
