import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  agentRules: false, // don't let `next dev` write an AGENTS.md into the repo
  // Workspace packages are shipped as TypeScript source.
  transpilePackages: ["@collabcode/shared", "@collabcode/db"],
  serverExternalPackages: ["@prisma/client"],
  // The browser talks to the REST API through the web origin, so session cookies are
  // same-site and no CORS is needed. /api/auth/* stays with Auth.js.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API_URL}/:path*` }];
  },
};

export default config;
