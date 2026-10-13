import { Server, type Extension } from "@hocuspocus/server";
import { Database } from "@hocuspocus/extension-database";
import { Redis } from "@hocuspocus/extension-redis";
import type { PrismaClient } from "@collabcode/db";
import { authorize, sanitizeAwarenessState, type ConnContext } from "./auth";
import { createPersistence } from "./persistence";
import { createAuthorshipExtension } from "./authorship/extension";

export interface CollabOptions {
  prisma: PrismaClient;
  secret: string;
  /** Set to share documents across several collab instances through Redis pub/sub. */
  redisUrl?: string;
  port?: number;
  /** Debounce for writing snapshots, in ms. */
  debounce?: number;
  /** How long authorship events are batched (defaults: 1.5 s idle, 5 s at most). */
  authorship?: { idleMs?: number; maxMs?: number };
}

export function createCollabServer(opts: CollabOptions) {
  const { extension: authorship, tracker } = createAuthorshipExtension(opts.prisma, opts.authorship);
  const extensions: Extension[] = [authorship, new Database(createPersistence(opts.prisma))];
  if (opts.redisUrl) {
    const url = new URL(opts.redisUrl);
    extensions.push(new Redis({ host: url.hostname, port: Number(url.port || 6379), prefix: "collabcode" }));
  }

  const server = new Server<ConnContext>({
    port: opts.port ?? 1234,
    address: "0.0.0.0",
    quiet: true,
    debounce: opts.debounce ?? 2000,
    maxDebounce: 10_000,
    extensions,
    // Refuse oversized frames (a single paste of a few MB is fine; hundreds of MB is abuse).
    websocketOptions: { maxPayload: 5 * 1024 * 1024 },

    // Runs for every connection to every document: validate the token, load the role from
    // the database, and make the connection read-only for viewers and commenters.
    // Hocuspocus then ignores document updates from that connection on the server side.
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const { context, readOnly } = await authorize({
        prisma: opts.prisma,
        secret: opts.secret,
        token,
        documentName,
      });
      connectionConfig.readOnly = readOnly;
      return context;
    },

    async beforeHandleAwareness({ states, context }) {
      if (!context) return; // not from a client connection (e.g. relayed through Redis)
      for (const state of states.values()) sanitizeAwarenessState(state, context);
    },

    // Plain HTTP health check for Docker / load balancers.
    async onRequest({ request, response }) {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", service: "collab" }));
        throw null; // an empty rejection tells Hocuspocus we've already answered
      }
    },
  });

  // Exposed for tests and diagnostics.
  return Object.assign(server, { authorship: tracker });
}
