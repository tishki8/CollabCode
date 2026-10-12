import type { FastifyRequest } from "fastify";
import type { PrismaClient } from "@collabcode/db";
import { unauthorized } from "../errors";

export interface AuthUser {
  id: string;
  name: string;
}

// Auth.js (database sessions) stores an opaque token in this cookie; the same token
// is the primary key we look up in the Session table. The __Secure- prefix is used over HTTPS.
export const COOKIE_NAMES = ["__Secure-authjs.session-token", "authjs.session-token"];

export const sessionTokenOf = (req: FastifyRequest): string | undefined =>
  COOKIE_NAMES.map((n) => req.cookies[n]).find(Boolean);

export async function requireUser(prisma: PrismaClient, req: FastifyRequest): Promise<AuthUser> {
  const token = sessionTokenOf(req);
  if (!token) throw unauthorized();
  const session = await prisma.session.findUnique({
    where: { sessionToken: token },
    select: { expires: true, user: { select: { id: true, name: true } } },
  });
  if (!session || session.expires.getTime() <= Date.now()) throw unauthorized();
  return session.user;
}
