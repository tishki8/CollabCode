import { prisma } from "@collabcode/db";
import { buildApp } from "./app";

const port = Number(process.env.API_PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const collabSecret = process.env.COLLAB_JWT_SECRET;
if (!collabSecret || collabSecret.length < 32) throw new Error("COLLAB_JWT_SECRET is required and must be at least 32 characters");
const collabPublicUrl = process.env.COLLAB_PUBLIC_URL ?? "ws://localhost:1234";

const app = await buildApp({ prisma, webOrigin, collabSecret, collabPublicUrl, logger: true });
await app.listen({ port, host: "0.0.0.0" });
