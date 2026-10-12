import { HocuspocusProvider } from "@hocuspocus/provider";
import type * as Y from "yjs";
import type { CollabTokenResponse } from "@collabcode/shared";
import { api, ApiRequestError } from "./client-api";

const TOKEN_REUSE_MS = 4 * 60 * 1000; // tokens live 10 minutes; reuse for 4 to stay well inside that
const cache = new Map<string, { at: number; session: Promise<CollabTokenResponse> }>();

/**
 * The collab token + our identity for a project. Cached briefly and shared, so opening a file
 * (editor + presence) and every reconnect attempt don't each hit the API. Failures aren't cached.
 */
export function fetchCollabSession(projectId: string): Promise<CollabTokenResponse> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < TOKEN_REUSE_MS) return hit.session;
  const session = api<CollabTokenResponse>("GET", `/projects/${projectId}/collab-token`);
  cache.set(projectId, { at: Date.now(), session });
  session.catch(() => cache.delete(projectId));
  return session;
}

/** 401/403/404 mean "you may not do this" (final); anything else (429, 5xx, network) is worth retrying. */
export const isFinalAuthError = (e: unknown) =>
  e instanceof ApiRequestError && (e.status === 401 || e.status === 403 || e.status === 404);

/**
 * Opens a Hocuspocus connection for one document. The token is a function so every
 * (re)connect fetches a fresh one: a connection that was down for longer than the token
 * lifetime still reconnects, and a user whose access was removed is refused.
 * While offline, edits stay in the local Y.Doc and are merged automatically on reconnect.
 */
export function openProvider(projectId: string, session: CollabTokenResponse, name: string, document: Y.Doc) {
  return new HocuspocusProvider({
    url: session.url,
    name,
    document,
    token: async () => (await fetchCollabSession(projectId)).token,
  });
}

export const fileRoom = (fileId: string) => `file:${fileId}`;
export const presenceRoom = (projectId: string) => `presence:${projectId}`;

/**
 * Like fetchCollabSession, but retries transient failures (throttling, API restarting) with
 * backoff until it succeeds, `shouldStop()` says to give up, or the server says "no access".
 * Returns null when stopped; throws only on a final "no access" answer.
 */
export async function fetchCollabSessionWithRetry(
  projectId: string,
  shouldStop: () => boolean,
  onTransientError?: () => void,
): Promise<CollabTokenResponse | null> {
  for (let attempt = 0; !shouldStop(); attempt++) {
    try {
      return await fetchCollabSession(projectId);
    } catch (e) {
      if (isFinalAuthError(e)) throw e;
      onTransientError?.();
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 15_000)));
    }
  }
  return null;
}
