import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@collabcode/db";
import { DEV_SESSION_TOKENS } from "@collabcode/shared";

// Development convenience: sign in as a seeded demo user without OAuth.
// Disabled unless DEV_LOGIN=true, and never in production builds.
export async function GET(req: NextRequest) {
  if (process.env.DEV_LOGIN !== "true" || process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }
  const who = req.nextUrl.searchParams.get("user") ?? "";
  const token = DEV_SESSION_TOKENS[who];
  if (!token) return new NextResponse("Unknown demo user", { status: 400 });
  // Only works if the seed script has been run.
  const session = await prisma.session.findUnique({ where: { sessionToken: token } });
  if (!session) return new NextResponse("Run the seed script first", { status: 400 });

  const res = NextResponse.redirect(new URL("/dashboard", req.nextUrl));
  res.cookies.set("authjs.session-token", token, { httpOnly: true, sameSite: "lax", path: "/", expires: session.expires });
  return res;
}
