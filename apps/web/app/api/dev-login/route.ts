import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@collabcode/db";
import { DEV_USER_EMAILS, safeRedirectPath } from "@collabcode/shared";

const SESSION_DAYS = 30;

// Development convenience: sign in as a seeded demo user without OAuth.
// Disabled unless DEV_LOGIN=true, and never in production builds.
export async function GET(req: NextRequest) {
  if (process.env.DEV_LOGIN !== "true" || process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }
  const email = DEV_USER_EMAILS[req.nextUrl.searchParams.get("user") ?? ""];
  if (!email) return new NextResponse("Unknown demo user", { status: 400 });
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return new NextResponse("Demo users are missing. Run the seed (pnpm db:seed; docker compose up does it automatically).", {
      status: 400,
    });
  }

  // A brand-new random session per login (the same kind of row Auth.js creates), so signing out
  // in one window never signs out another, and there is no fixed token to guess.
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  const sessionToken = randomUUID();
  await prisma.session.create({ data: { sessionToken, userId: user.id, expires } });

  const res = NextResponse.redirect(new URL(safeRedirectPath(req.nextUrl.searchParams.get("next")), req.nextUrl));
  res.cookies.set("authjs.session-token", sessionToken, { httpOnly: true, sameSite: "lax", path: "/", expires });
  return res;
}
