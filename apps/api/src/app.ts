import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError, type ZodType } from "zod";
import type { PrismaClient } from "@collabcode/db";
import { HttpError } from "./errors";
import { anyCredentialOf, requireUser, type AuthUser } from "./plugins/auth";
import { hashToken } from "./services/tokens";
import { projectRoutes } from "./routes/projects";
import { fileRoutes } from "./routes/files";
import { shareLinkRoutes } from "./routes/share-links";
import { collabRoutes } from "./routes/collab";
import { meRoutes } from "./routes/me";
import { authorshipRoutes } from "./routes/authorship";
import { reviewRoutes } from "./routes/review";
import { checkpointRoutes } from "./routes/checkpoints";
import { createCollabClient, noCollab, type CollabClient } from "./services/collab";

export interface AppDeps {
  prisma: PrismaClient;
  /** The web app's origin, e.g. http://localhost:3000. Used for the CSRF check. */
  webOrigin: string;
  /** Secret shared with the collab server for signing collab tokens (HS256). */
  collabSecret: string;
  /** WebSocket URL of the collab server as seen from the browser. */
  collabPublicUrl: string;
  /**
   * How the API reaches the collab server's signed /internal endpoints (accepting suggestions,
   * restoring versions, checkpoints). Give a URL, or an object (tests use an in-memory one).
   */
  collab?: CollabClient | { url: string };
  /**
   * How many reverse proxies sit in front of the API (0 = none). The web app proxies browser
   * requests to the API, so with 1 the real client address is the one the proxy appended to
   * X-Forwarded-For (anything the client put there itself is ignored).
   */
  trustProxyHops?: number;
  logger?: boolean;
}

/** Everything a route needs, passed explicitly so tests can swap pieces. */
export interface Ctx {
  prisma: PrismaClient;
  user(req: FastifyRequest): Promise<AuthUser>;
  /** Set cookies with the Secure flag (when the site is served over HTTPS). */
  secureCookies: boolean;
  parse<T>(schema: ZodType<T>, data: unknown): T;
}

/**
 * Trust exactly the first `hops` reverse proxies. Hop 0 is the connection peer (the web app's
 * proxy); trusting only that hop means anything a client put in X-Forwarded-For itself is ignored.
 */
export const trustHops = (hops: number) => (hops > 0 ? (_address: string, hop: number) => hop < hops : false);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const options: FastifyServerOptions = {
    logger: deps.logger ?? false,
    bodyLimit: 64 * 1024,
    trustProxy: trustHops(deps.trustProxyHops ?? 0),
  };
  const app = Fastify(options);

  await app.register(helmet);
  await app.register(cookie);
  // In-memory counters for now; moves to the Redis store when Redis is wired in (Phase 6).
  // Limits are counted per signed-in session, not per IP: people on the same office/campus
  // network (a whole team) must not throttle each other. Anonymous requests fall back to the IP.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const token = anyCredentialOf(req);
      return token ? `session:${hashToken(token)}` : `ip:${req.ip}`;
    },
  });

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
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code, details: err.details });
    }
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
    user: async (req) => {
      const user = await requireUser(deps.prisma, req);
      // A page that knows who it is (see apps/web/lib/client-api.ts) says so on every call. If the
      // session cookie now belongs to someone else (a second sign-in in the same browser replaced it),
      // refuse instead of silently acting as the other person.
      const expected = req.headers["x-expected-user"];
      if (typeof expected === "string" && expected !== "" && expected !== user.id) {
        throw new HttpError(409, `You are now signed in as ${user.name}. Reload this page to continue as ${user.name}.`, { signedInAs: { id: user.id, name: user.name } }, "IDENTITY_CHANGED");
      }
      return user;
    },
    secureCookies: deps.webOrigin.startsWith("https://"),
    parse: (schema, data) => schema.parse(data),
  };

  app.get("/health", async () => ({ status: "ok" }));
  await app.register(projectRoutes(ctx), { prefix: "/projects" });
  await app.register(fileRoutes(ctx));
  await app.register(meRoutes(ctx));
  await app.register(authorshipRoutes(ctx));
  const collab = !deps.collab ? noCollab : "url" in deps.collab ? createCollabClient(deps.collab.url, deps.collabSecret) : deps.collab;
  await app.register(reviewRoutes(ctx, collab));
  await app.register(checkpointRoutes(ctx, collab));
  await app.register(shareLinkRoutes(ctx));
  await app.register(collabRoutes(ctx, { secret: deps.collabSecret, publicUrl: deps.collabPublicUrl }));

  return app;
}
