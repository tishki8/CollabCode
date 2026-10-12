import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const config: NextConfig = {
  agentRules: false, // don't let `next dev` write an AGENTS.md into the repo
  // Workspace packages are shipped as TypeScript source.
  transpilePackages: ["@collabcode/shared", "@collabcode/db"],
  serverExternalPackages: ["@prisma/client"],
  // Keep Monaco out of the bundle: it is served from /monaco/vs and y-monaco is pointed at it.
  turbopack: {
    resolveAlias: {
      "monaco-editor/esm/vs/editor/editor.api.js": "./lib/monaco-shim.ts",
    },
  },
  // The browser talks to the REST API through the web origin, so session cookies are
  // same-site and no CORS is needed. /api/auth/* stays with Auth.js.
  // A share link's URL contains its secret. Never send it onward as a Referer, never cache it.
  async headers() {
    return [
      {
        source: "/join/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API_URL}/:path*` }];
  },
};

export default config;
