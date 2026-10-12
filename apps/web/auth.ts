import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@collabcode/db";

// Providers read AUTH_GOOGLE_ID/SECRET and AUTH_GITHUB_ID/SECRET from the environment.
// Only enable the ones that are configured so the sign-in page never shows a dead button.
export const enabledProviders = [
  ...(process.env.AUTH_GOOGLE_ID ? [{ id: "google", name: "Google" }] : []),
  ...(process.env.AUTH_GITHUB_ID ? [{ id: "github", name: "GitHub" }] : []),
];

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  // Database sessions: the cookie is an opaque token looked up in the Session table,
  // which is exactly what the REST API does to identify the caller.
  session: { strategy: "database" },
  trustHost: true,
  providers: [
    ...(process.env.AUTH_GOOGLE_ID ? [Google] : []),
    ...(process.env.AUTH_GITHUB_ID ? [GitHub] : []),
  ],
  pages: { signIn: "/" },
  events: {
    // Remember the GitHub identity: needed later to credit people in exported commits.
    async signIn({ user, account, profile }) {
      if (account?.provider === "github" && user.id && profile) {
        const p = profile as { id?: number | string; login?: string };
        await prisma.user.update({
          where: { id: user.id },
          data: { githubLogin: p.login ?? null, githubId: p.id != null ? Number(p.id) : null },
        });
      }
    },
  },
});
