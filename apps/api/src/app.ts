import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError, type ZodType } from "zod";
import type { PrismaClient } from "@collabcode/db";
import { HttpError } from "./errors";
import { requireUser, type AuthUser } from "./plugins/auth";
import { projectRoutes } from "./routes/projects";
import { fileRoutes } from "./routes/files";

export interface AppDeps {
  prisma: PrismaClient;
  /** The web app's origin, e.g. http://localhost:3000. Used for the CSRF check. */
  webOrigin: string;
  logger?: boolean;
}

/** Everything a route needs, passed explicitly so tests can swap pieces. */
export interface Ctx {
  prisma: PrismaClient;
  user(req: FastifyRequest): Promise<AuthUser>;
  parse<T>(schema: ZodType<T>, data: unknown): T;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 64 * 1024 });

  await app.register(helmet);
  await app.register(cookie);
  // In-memory counters for now; moves to the Redis store when Redis is wired in (Phase 6).
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  // CSRF defence in depth (on top of SameSite=Lax cookies): browsers always send Origin
  // on cross-site writes, so a write whose Origin is not our web app is rejected.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== deps.webOrigin) {
      return reply.code(403).send({ error: "Cross-origin request blocked" });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid input",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    // Prisma unique-constraint violation (e.g. two files with the same name raced)
    if ((err as { code?: string }).code === "P2002") {
      return reply.code(409).send({ error: "That name is already taken here" });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error(err);
    return reply.code(500).send({ error: "Internal server error" });
  });

  const ctx: Ctx = {
    prisma: deps.prisma,
    user: (req) => requireUser(deps.prisma, req),
    parse: (schema, data) => schema.parse(data),
  };

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(projectRoutes(ctx), { prefix: "/projects" });
  await app.register(fileRoutes(ctx));

  return app;
}
