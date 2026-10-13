import { prisma } from "@collabcode/db";
import { buildApp } from "./app";

const port = Number(process.env.API_PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const collabSecret = process.env.COLLAB_JWT_SECRET;
if (!collabSecret || collabSecret.length < 32) throw new Error("COLLAB_JWT_SECRET is required and must be at least 32 characters");
const collabPublicUrl = process.env.COLLAB_PUBLIC_URL ?? "ws://localhost:1234";

// 1 when the API is only reached through the web app's /api/v1 proxy (see docker-compose.yml).
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);

// The collab server as the API reaches it on the private network (never the browser-facing URL).
const collabInternalUrl = process.env.COLLAB_INTERNAL_URL ?? "http://localhost:1234";

const app = await buildApp({ prisma, webOrigin, collabSecret, collabPublicUrl, collab: { url: collabInternalUrl }, trustProxyHops, logger: true });
await app.listen({ port, host: "0.0.0.0" });
