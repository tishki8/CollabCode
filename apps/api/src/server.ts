import { prisma } from "@collabcode/db";
import { buildApp } from "./app";

const port = Number(process.env.API_PORT ?? 4000);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const app = await buildApp({ prisma, webOrigin, logger: true });
await app.listen({ port, host: "0.0.0.0" });
