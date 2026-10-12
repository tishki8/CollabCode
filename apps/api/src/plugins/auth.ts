import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@collabcode/db";
import { unauthorized } from "../errors";
import { hashToken } from "../services/tokens";

export interface AuthUser {
  id: string;
  name: string;
  /** Guests have a display name only (no account); they can never own projects. */
  isGuest: boolean;
}

// Auth.js (database sessions) stores an opaque token in this cookie; the same token
// is the primary key we look up in the Session table. The __Secure- prefix is used over HTTPS.
export const COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"];

/** Guests get their own cookie: a random secret whose hash is stored in GuestSession. */
export const GUEST_COOKIE = "cc_guest";

export const sessionTokenOf = (req: FastifyRequest): string | undefined =>
  COOKIE_NAMES.map((n) => req.cookies[n]).find(Boolean);

/** Any credential cookie, used to count rate limits per person instead of per IP. */
export const anyCredentialOf = (req: FastifyRequest): string | undefined =>
  sessionTokenOf(req) ?? req.cookies[GUEST_COOKIE];

/** Who is calling: a signed-in user (Auth.js session) or, failing that, a guest. */
export async function requireUser(prisma: PrismaClient, req: FastifyRequest): Promise<AuthUser> {
  const token = sessionTokenOf(req);
  if (token) {
    const session = await prisma.session.findUnique({
      where: { sessionToken: token },
      select: { expires: true, user: { select: { id: true, name: true, isGuest: true } } },
    });
    if (session && session.expires.getTime() > Date.now()) return session.user;
  }

  const guestToken = req.cookies[GUEST_COOKIE];
  if (guestToken) {
    const guest = await prisma.guestSession.findUnique({
      where: { tokenHash: hashToken(guestToken) },
      select: { expiresAt: true, user: { select: { id: true, name: true, isGuest: true } } },
    });
    if (guest && guest.expiresAt.getTime() > Date.now() && guest.user.isGuest) return guest.user;
  }
  throw unauthorized();
}
