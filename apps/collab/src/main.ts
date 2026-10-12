import { prisma } from "@collabcode/db";
import { createCollabServer } from "./server";

const secret = process.env.COLLAB_JWT_SECRET;
if (!secret || secret.length < 32) throw new Error("COLLAB_JWT_SECRET is required and must be at least 32 characters");

const port = Number(process.env.PORT ?? 1234);
const server = createCollabServer({ prisma, secret, redisUrl: process.env.REDIS_URL, port });
await server.listen();
console.log(`collab listening on ${port}`);
